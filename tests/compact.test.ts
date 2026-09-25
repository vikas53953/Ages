import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import {
  SUMMARY_SYSTEM,
  compactSession,
  loadSummary,
  modelSummarizer,
  needsCompaction,
  splitForCompaction,
  transcriptOf,
  type Summarizer,
} from "../src/compact.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { appendMessage, createSession, loadMessages, messageText, type ChatMessage } from "../src/session.ts";

const at = "2026-09-20T00:00:00Z";

async function sessionWith(rows: ChatMessage[]) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-compact-"));
  const session = await createSession(cwd, "c1");
  for (const row of rows) await appendMessage(cwd, session.id, row);
  return { cwd, id: session.id };
}

function turns(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => [
    { role: "user" as const, content: `question-${i}`, at },
    { role: "assistant" as const, content: `answer-${i}`, at },
  ]).flat();
}

const toolTurn: ChatMessage[] = [
  { role: "user", content: "read the config", at },
  {
    role: "assistant",
    at,
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "cfg.json" } }],
  },
  {
    role: "tool",
    at,
    content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "PORT=8080" } }],
  },
  { role: "assistant", content: [{ type: "text", text: "The port is 8080." }], at },
];

describe("splitForCompaction", () => {
  it("cuts only at the start of a user turn, so tool pairs stay together", () => {
    const rows = [...toolTurn, ...turns(2)];
    const { old, recent } = splitForCompaction(rows, 2);
    expect(old).toEqual(toolTurn);
    expect(recent.map(messageText)).toEqual(["question-0", "answer-0", "question-1", "answer-1"]);
  });

  it("folds nothing when there are no more turns than it keeps", () => {
    expect(splitForCompaction(turns(3), 3).old).toHaveLength(0);
  });
});

describe("compactSession", () => {
  it("writes a model summary to summary.md and keeps the recent turns as they were", async () => {
    const { cwd, id } = await sessionWith([...toolTurn, ...turns(3)]);
    let seen = "";
    const summarize: Summarizer = async ({ transcript }) => {
      seen = transcript;
      return "User wants the port. cfg.json says PORT=8080.";
    };
    const result = await compactSession(cwd, id, { keepTurns: 2, summarize });
    expect(result).toMatchObject({ summarized: 6, kept: 4, method: "model" });
    expect(seen).toContain("called read");
    expect(seen).toContain("PORT=8080");
    expect(await loadSummary(cwd, id)).toBe("User wants the port. cfg.json says PORT=8080.");
    expect((await loadMessages(cwd, id)).map(messageText)).toEqual(["question-1", "answer-1", "question-2", "answer-2"]);
  });

  it("passes the previous summary to the next compaction", async () => {
    const { cwd, id } = await sessionWith(turns(4));
    const previous: string[] = [];
    const summarize: Summarizer = async (input) => {
      previous.push(input.previous);
      return `summary-${previous.length}`;
    };
    await compactSession(cwd, id, { keepTurns: 1, summarize });
    for (const row of turns(2)) await appendMessage(cwd, id, row);
    await compactSession(cwd, id, { keepTurns: 1, summarize });
    expect(previous).toEqual(["", "summary-1"]);
    expect(await loadSummary(cwd, id)).toBe("summary-2");
  });

  it("falls back to the line-by-line summary when the model fails", async () => {
    const { cwd, id } = await sessionWith(turns(3));
    const result = await compactSession(cwd, id, {
      keepTurns: 1,
      summarize: async () => {
        throw new Error("provider down");
      },
    });
    expect(result.method).toBe("extract");
    expect(result.error).toBe("provider down");
    const summary = await readFile(result.path, "utf8");
    expect(summary).toContain("- user: question-0");
    expect(summary).toContain("- assistant: answer-1");
  });

  it("modelSummarizer sends the transcript and previous summary to the model", async () => {
    let request = "";
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        request = JSON.stringify(options.prompt);
        return {
          content: [{ type: "text", text: "  folded notes  " }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const text = await modelSummarizer(model)({ transcript: "user: hi", previous: "OLD-NOTES" });
    expect(text).toBe("folded notes");
    expect(request).toContain("OLD-NOTES");
    expect(request).toContain("user: hi");
    expect(request).toContain(SUMMARY_SYSTEM.slice(0, 40));
  });

  it("measures history size in characters", () => {
    expect(needsCompaction(turns(1), 10)).toBe(true);
    expect(needsCompaction(turns(1), 10_000)).toBe(false);
    expect(needsCompaction(turns(50), 0)).toBe(false);
    expect(transcriptOf(toolTurn)).toContain("read returned: PORT=8080");
  });
});

describe("auto-compaction before a turn", () => {
  it("compacts once history is too big and puts the summary in the system prompt", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-autocompact-"));
    await writeFile(path.join(cwd, "gate.config.json"), JSON.stringify({ compactAtChars: 60, compactKeepTurns: 1 }));
    const systems: string[] = [];
    const sent: number[] = [];
    const opts = {
      mockJev: true,
      yes: false,
      local: true,
      summarize: (async ({ transcript }) => `SUMMARY(${transcript.split("\n").length} lines)`) as Summarizer,
      generate: (async ({ system, messages }) => {
        systems.push(system);
        sent.push(messages.length);
        return { text: `reply ${systems.length} ${"x".repeat(40)}`, inputTokens: 0, outputTokens: 0 };
      }) as NonNullable<Parameters<typeof handleLine>[2]["generate"]>,
    };
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("first question", state, opts);
    await handleLine("second question", state, opts);
    const third = await handleLine("third question", state, opts);
    expect(third.notice).toContain("Auto-compacted");
    expect(third.notice).toContain("model");
    expect(systems[2]).toContain("Earlier in this session (compacted summary");
    expect(systems[2]).toContain("SUMMARY(");
    // Turn 3 sent only the kept turn plus its own prompt, not the whole history.
    expect(sent[2]).toBeLessThan(sent[1]! + 2);
  });

  it("/compact reports what it did", async () => {
    const { cwd } = await sessionWith(turns(5));
    const state = await startState(cwd, { local: true, mockJev: true });
    const out = await handleLine("/compact", state, { mockJev: true, yes: false, local: true });
    expect(out.output).toMatch(/compacted 4 messages into .*summary\.md \(extract\), kept 6/);
  });
});
