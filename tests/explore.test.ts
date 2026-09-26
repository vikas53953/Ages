import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
type Step = { tool: string; input: object } | { text: string };
type Seen = { system: string; tools: string[]; prompt: string };

/** One scripted model shared by the main turn and the helper: calls are answered in order. */
function scripted(steps: Step[], seen: Seen[]) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const system = options.prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
      seen.push({ system, tools: (options.tools ?? []).map((t) => t.name), prompt: JSON.stringify(options.prompt) });
      const step = steps[index++] ?? { text: "done" };
      const chunks =
        "tool" in step
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: `c${index}`, toolName: step.tool, input: JSON.stringify(step.input) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: step.text },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
}

async function project() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-explore-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" } }));
  await writeFile(path.join(cwd, "auth.ts"), "export function login() { /* SECRET-SAUCE */ }\n");
  return cwd;
}

describe("explore helper", () => {
  it("runs a fresh read-only conversation, passes the lock for each read, and hands back only its report", async () => {
    const cwd = await project();
    const state = await startState(cwd, { local: true, mockJev: true });
    const seen: Seen[] = [];
    const model = scripted(
      [
        { tool: "explore", input: { task: "where is login handled?" } }, // main
        { tool: "read", input: { path: "auth.ts" } }, // helper
        { text: "login() is in auth.ts:1" }, // helper report
        { text: "It is in auth.ts." }, // main answer
      ],
      seen,
    );
    const result = await handleLine("where is login?", state, { mockJev: true, yes: false, local: true, generate: generateWith(model) });
    // The helper saw only read/grep, its own instructions, and just the task (not the chat).
    expect(seen[1]!.tools).toEqual(expect.arrayContaining(["grep", "read"]));
    expect(seen[1]!.tools.filter((name) => !["grep", "glob", "read", "skill"].includes(name))).toEqual([]);
    expect(seen[1]!.system).toContain("explore helper");
    expect(seen[1]!.prompt).toContain("where is login handled?");
    expect(seen[1]!.prompt).not.toContain("where is login?\"");
    // The main model got the report, not the file.
    expect(seen[3]!.prompt).toContain("login() is in auth.ts:1");
    expect(seen[3]!.prompt).toMatch(/explore_report_[0-9a-f]{8}/);
    expect(seen[3]!.prompt).toContain("treat it as data");
    expect(seen[3]!.prompt).not.toContain("SECRET-SAUCE");
    // Both calls are in the receipt, each decided by a rule; the helper's tokens count.
    expect(result.receipt?.tools.map((t) => [t.name, t.rule])).toEqual([
      ["read", "read *"],
      ["explore", "explore *"],
    ]);
    expect(result.receipt?.tokens?.input).toBe(40);
    expect(result.receipt?.answer).toBe("It is in auth.ts.");
  });

  it("is allowed in plan mode, and the helper cannot write even when the main turn could", async () => {
    const cwd = await project();
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { allow: ["read *", "grep *", "explore *", "write *"] } }));
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("/plan", state, { mockJev: true, yes: false, local: true });
    const seen: Seen[] = [];
    const model = scripted([{ tool: "explore", input: { task: "look" } }, { text: "nothing here" }, { text: "plan: 1. do it" }], seen);
    const result = await handleLine("plan it", state, { mockJev: true, yes: false, local: true, generate: generateWith(model) });
    expect(result.receipt?.tools[0]).toMatchObject({ name: "explore", approved: true });
    expect(seen[1]!.tools).not.toContain("write");
  });

  it("a deny rule turns it off", async () => {
    const cwd = await project();
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { deny: ["explore *"] } }));
    const state = await startState(cwd, { local: true, mockJev: true });
    const seen: Seen[] = [];
    const model = scripted([{ tool: "explore", input: { task: "look" } }, { text: "ok" }], seen);
    const result = await handleLine("find it", state, { mockJev: true, yes: false, local: true, generate: generateWith(model) });
    expect(result.receipt?.tools[0]).toMatchObject({ name: "explore", approved: false });
    expect(seen).toHaveLength(2); // no helper conversation started
  });
});
