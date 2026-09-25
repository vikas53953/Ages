import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { loadMemory } from "../src/memory.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { runHeadless } from "../src/headless.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
function remembering(note: string) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      const chunks =
        call === 1
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "r1", toolName: "remember", input: JSON.stringify({ note }) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "ok" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
}
async function project(rules: object = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-remember-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules }));
  return cwd;
}

describe("remember (auto memory)", () => {
  it("asks with the exact note, even with an allow rule; yes keeps it, no does not; never 'always'", async () => {
    const cwd = await project({ allow: ["remember *"] });
    const asked: Array<{ q: string; always?: boolean }> = [];
    const run = async (note: string, answer: boolean) =>
      handleLine("go", await startState(cwd, { local: true, mockJev: true }), { mockJev: true, yes: false, local: true, generate: generateWith(remembering(note)) }, async (question, options) => {
        asked.push({ q: question, always: Boolean(options?.always) });
        return answer;
      });
    await run("tests run with npm test", false);
    expect(await loadMemory(cwd)).toBe("");
    await run("tests run with npm test", true);
    expect(await loadMemory(cwd)).toContain("tests run with npm test");
    expect(asked).toHaveLength(2);
    expect(asked[0]!.q).toContain("note: tests run with npm test");
    expect(asked.every((a) => !a.always)).toBe(true);
  });

  it("refuses secrets without asking; headless never keeps a note", async () => {
    const cwd = await project();
    const asked: string[] = [];
    await handleLine("go", await startState(cwd, { local: true, mockJev: true }), { mockJev: true, yes: false, local: true, generate: generateWith(remembering(`token ghp_${"a".repeat(40)}`)) }, async (q) => {
      asked.push(q);
      return true;
    });
    expect(asked).toHaveLength(0);
    expect(await loadMemory(cwd)).toBe("");
    const code = await runHeadless({ prompt: "go", cwd, opts: { mockJev: true, yes: false, local: true, generate: generateWith(remembering("x")) }, json: false, write: () => {} });
    expect(code).toBe(2);
    expect(await loadMemory(cwd)).toBe("");
  });
});
