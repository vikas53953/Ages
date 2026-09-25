import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { headlessPrompt, runHeadless, type HeadlessLine } from "../src/headless.ts";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { Readable } from "node:stream";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
type Step = { tool: string; input: object } | { text: string };
function scripted(steps: Step[]) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-headless-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" } }));
  await writeFile(path.join(cwd, "README.md"), "hello headless\n");
  return cwd;
}

const steps = (): Step[] => [
  { tool: "read", input: { path: "README.md" } },
  { tool: "write", input: { path: "out.txt", contents: "x" } },
  { text: "Read it; could not write." },
];

describe("aegis -p", () => {
  it("--json: every event, the question it could not ask (denied), then one result; exit 2 because a call was denied", async () => {
    const cwd = await project();
    const lines: string[] = [];
    const code = await runHeadless({
      prompt: "read and write",
      cwd,
      opts: { mockJev: true, yes: false, local: true, generate: generateWith(scripted(steps())) },
      json: true,
      write: (text) => lines.push(text),
    });
    expect(code).toBe(2);
    const parsed = lines.map((line) => JSON.parse(line) as HeadlessLine);
    expect(parsed.some((line) => line.type === "event" && line.event.type === "tool_start")).toBe(true);
    expect(parsed.find((line) => line.type === "question")).toMatchObject({ answer: "denied" });
    const result = parsed.at(-1) as Extract<HeadlessLine, { type: "result" }>;
    expect(result).toMatchObject({ type: "result", ok: true, answer: "Read it; could not write.", denied: 1 });
    expect(result.tools.map((tool) => [tool.name, tool.approved])).toEqual([
      ["read", true],
      ["write", false],
    ]);
    expect(result.tokens).toEqual({ input: 30, output: 6 });
    expect(existsSync(path.join(cwd, "out.txt"))).toBe(false);
  });

  it("--yes approves questions (the explicit opt-in); exit 0", async () => {
    const cwd = await project();
    const code = await runHeadless({
      prompt: "read and write",
      cwd,
      opts: { mockJev: true, yes: true, local: true, generate: generateWith(scripted(steps())) },
      json: false,
      write: () => {},
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(cwd, "out.txt"))).toBe(true);
  });

  it("a deny rule still wins over --yes", async () => {
    const cwd = await project();
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { deny: ["write out.txt"] } }));
    const code = await runHeadless({
      prompt: "read and write",
      cwd,
      opts: { mockJev: true, yes: true, local: true, generate: generateWith(scripted(steps())) },
      json: false,
      write: () => {},
    });
    expect(code).toBe(2);
    expect(existsSync(path.join(cwd, "out.txt"))).toBe(false);
  });

  it("stdin is added to the prompt", async () => {
    expect(await headlessPrompt("review this", Object.assign(Readable.from(["diff --git a b"]), { isTTY: false }))).toBe("review this\n\ndiff --git a b");
    expect(await headlessPrompt("", Object.assign(Readable.from(["only stdin"]), { isTTY: false }))).toBe("only stdin");
    expect(await headlessPrompt("arg only", Object.assign(Readable.from([]), { isTTY: true }))).toBe("arg only");
  });

  it("the built CLI: `aegis -p --json --local` prints JSON lines and exits 0", async () => {
    const cwd = await project();
    const main = path.resolve("dist/main.js");
    const run = spawnSync(process.execPath, [main, "-p", "--json", "--local", "--mock-jev", "read README.md"], {
      cwd,
      encoding: "utf8",
      input: "",
      env: { ...process.env, AEGIS_HOME: await mkdtemp(path.join(os.tmpdir(), "aegis-headless-home-")) },
    });
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as HeadlessLine);
    const result = lines.at(-1) as Extract<HeadlessLine, { type: "result" }>;
    expect(result.type).toBe("result");
    expect(result.answer).toContain("hello headless");
  });
});
