import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { footerText } from "../src/tui-layout.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type Step = { tool: string; input: object } | { text: string };

function scripted(steps: Step[], systems: string[]) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      systems.push(JSON.stringify(options.prompt[0]));
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

async function project(steps: Step[]) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-plan-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { allow: ["read *", "grep *", "write *"] } }));
  await writeFile(path.join(cwd, "README.md"), "hello\n");
  const systems: string[] = [];
  const state = await startState(cwd, { local: true, mockJev: true });
  const opts = { mockJev: true, yes: false, local: true, generate: generateWith(scripted(steps, systems)) };
  const mustNotAsk = async () => {
    throw new Error("must not ask");
  };
  return { cwd, state, opts, systems, mustNotAsk };
}

describe("plan mode", () => {
  it("reads work, writes are refused without asking, and the plan prompt is in the system prompt", async () => {
    const { cwd, state, opts, systems, mustNotAsk } = await project([
      { tool: "read", input: { path: "README.md" } },
      { tool: "write", input: { path: "out.txt", contents: "x" } },
      { text: "1. Create out.txt" },
    ]);
    expect((await handleLine("/plan", state, opts)).output).toContain("plan mode on");
    const result = await handleLine("make out.txt", state, opts, mustNotAsk);
    expect(result.receipt?.tools.map((tool) => [tool.name, tool.approved])).toEqual([
      ["read", true],
      ["write", false],
    ]);
    expect(result.receipt?.tools[1]?.deniedReason).toContain("plan mode is read-only");
    expect(existsSync(path.join(cwd, "out.txt"))).toBe(false);
    expect(systems[0]).toContain("You are in plan mode");
    expect((await handleLine("/status", state, opts)).output).toContain("plan      on");
    expect(footerText({ modelMode: "auto", model: "auto", jev: "off", provider: "local", plan: true })).toContain("PLAN · auto");
  });

  it("/plan go leaves plan mode and carries the plan out", async () => {
    const { cwd, state, opts, systems, mustNotAsk } = await project([
      { text: "1. Create out.txt" },
      { tool: "write", input: { path: "out.txt", contents: "made" } },
      { text: "Done. Tested by reading it back." },
    ]);
    await handleLine("/plan make out.txt", state, opts, mustNotAsk);
    expect(state.planMode).toBe(true);
    const go = await handleLine("/plan go", state, opts, mustNotAsk);
    expect(state.planMode).toBe(false);
    expect(go.receipt?.prompt).toContain("The plan is approved");
    expect(await readFile(path.join(cwd, "out.txt"), "utf8")).toBe("made");
    expect(systems.at(-1)).not.toContain("You are in plan mode");
  });

  it("/plan off leaves without running anything; /plan go needs plan mode", async () => {
    const { state, opts } = await project([]);
    expect((await handleLine("/plan go", state, opts)).output).toContain("not on");
    await handleLine("/plan", state, opts);
    expect((await handleLine("/plan off", state, opts)).output).toContain("plan mode off");
    expect(state.planMode).toBe(false);
  });
});

describe("plan mode with the Claude Code engine", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it("Claude Code gets --permission-mode plan and its writes are refused by Aegis", async () => {
    const fixture = path.resolve("tests/fixtures/fake-claude.mjs");
    if (process.platform === "win32") {
      const dir = await mkdtemp(path.join(os.tmpdir(), "fake-claude-"));
      process.env.AEGIS_CLAUDE_BIN = path.join(dir, "claude.cmd");
      await writeFile(process.env.AEGIS_CLAUDE_BIN, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
    } else {
      chmodSync(fixture, 0o755);
      process.env.AEGIS_CLAUDE_BIN = fixture;
    }
    const { cwd, state, opts, mustNotAsk } = await project([]);
    await handleLine("/model claude-code", state, opts);
    await handleLine("/plan", state, opts);
    const result = await handleLine("add a ping script", state, opts, mustNotAsk);
    expect(result.receipt?.answer).toContain("plan mode is read-only");
    expect(result.receipt?.answer).toContain("mode=plan");
    expect(existsSync(path.join(cwd, "scripts", "ping.ps1"))).toBe(false);
  });
});
