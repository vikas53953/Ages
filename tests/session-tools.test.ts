import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateWith, toModelMessages } from "../src/loop.ts";
import { handleLine, startState } from "../src/runtime.ts";
import {
  capToolResults,
  loadMessages,
  messageText,
  repairHistory,
  type ChatMessage,
} from "../src/session.ts";

const at = "2026-09-25T00:00:00Z";
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolCallStream(id: string, toolName: string, input: object) {
  return simulateReadableStream({
    chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) },
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage },
    ],
  });
}

function textStream(text: string) {
  return simulateReadableStream({
    chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "t" },
      { type: "text-delta" as const, id: "t", delta: text },
      { type: "text-end" as const, id: "t" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
    ],
  });
}

describe("session keeps tool calls and results", () => {
  it("turn 2 sees what the read tool returned in turn 1", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-memory-"));
    await writeFile(path.join(cwd, "notes.txt"), "line 40: SECRET-LINE-40 sets the retry limit", "utf8");
    const prompts: string[] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        call += 1;
        if (call === 1) return { stream: toolCallStream("call-1", "read", { path: "notes.txt" }) };
        if (call === 2) return { stream: textStream("I read notes.txt.") };
        return { stream: textStream("Line 40 sets the retry limit.") };
      },
    });
    const opts = { mockJev: true, yes: false, local: true, generate: generateWith(model) };
    const state = await startState(cwd, { local: true, mockJev: true });

    await handleLine("read notes.txt", state, opts);
    const saved = await loadMessages(cwd, state.session.id);
    expect(saved.map((row) => row.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(JSON.stringify(saved[2])).toContain("SECRET-LINE-40");
    expect(messageText(saved[3]!)).toBe("I read notes.txt.");

    await handleLine("what does line 40 do?", state, opts);
    expect(call).toBe(3);
    // The third model call is turn 2. It must carry turn 1's tool call and its result.
    expect(prompts[2]).toContain("SECRET-LINE-40");
    expect(prompts[2]).toContain("call-1");
  });

  it("keeps the model's own words, not the receipt card, as the assistant message", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-memory-text-"));
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: textStream("Just an answer.") }) });
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("hello", state, { mockJev: true, yes: false, local: true, generate: generateWith(model) });
    const saved = await loadMessages(cwd, state.session.id);
    expect(saved.map((row) => messageText(row))).toEqual(["hello", "Just an answer."]);
    expect(JSON.stringify(saved)).not.toContain("Outcome");
  });
});

describe("history helpers", () => {
  it("caps a long tool result before it is saved", () => {
    const rows: ChatMessage[] = [
      {
        role: "tool",
        at,
        content: [
          { type: "tool-result", toolCallId: "a", toolName: "read", output: { type: "text", value: "x".repeat(9_000) } },
          { type: "tool-result", toolCallId: "b", toolName: "read", output: { type: "json", value: { big: "y".repeat(9_000) } } },
        ],
      },
    ];
    const [capped] = capToolResults(rows, 100);
    const parts = capped!.content as unknown as Array<{ output: { type: string; value: string } }>;
    expect(parts[0]!.output.value.length).toBeLessThan(200);
    expect(parts[0]!.output.value).toContain("not kept in the session");
    expect(parts[1]!.output.type).toBe("text");
    expect(parts[1]!.output.value).toContain("not kept in the session");
  });

  it("drops a tool call whose result was lost, and a result without its call", () => {
    const rows: ChatMessage[] = [
      { role: "user", content: "go", at },
      {
        role: "assistant",
        at,
        content: [
          { type: "text", text: "reading" },
          { type: "tool-call", toolCallId: "kept", toolName: "read", input: {} },
          { type: "tool-call", toolCallId: "lost", toolName: "read", input: {} },
        ],
      },
      {
        role: "tool",
        at,
        content: [
          { type: "tool-result", toolCallId: "kept", toolName: "read", output: { type: "text", value: "ok" } },
          { type: "tool-result", toolCallId: "orphan", toolName: "read", output: { type: "text", value: "?" } },
        ],
      },
      { role: "assistant", content: "", at },
    ];
    const fixed = repairHistory(rows);
    const text = JSON.stringify(fixed);
    expect(text).toContain("kept");
    expect(text).not.toContain("lost");
    expect(text).not.toContain("orphan");
    expect(fixed).toHaveLength(3);
  });

  it("still loads and sends old text-only sessions", () => {
    const old: ChatMessage[] = [
      { role: "user", content: "hi", at },
      { role: "assistant", content: "Outcome  completed\n\nhello", at },
    ];
    expect(toModelMessages(old)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Outcome  completed\n\nhello" },
    ]);
  });
});
