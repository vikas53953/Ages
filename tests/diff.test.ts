import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { parseLine } from "../src/commands.ts";
import { textLines, unifiedDiff } from "../src/diff.ts";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
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

describe("unifiedDiff", () => {
  it("hunks with context; far-apart changes get separate hunks", () => {
    const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const now = old.replace("line 3\n", "line three\n").replace("line 25\n", "");
    const { lines, stat } = unifiedDiff(old, now);
    expect(stat).toEqual({ added: 1, removed: 2 });
    expect(lines.filter((line) => line.startsWith("@@"))).toEqual(["@@ -1,6 +1,6 @@", "@@ -22,7 +22,6 @@"]);
    expect(lines).toContain("-line 3");
    expect(lines).toContain("+line three");
    expect(lines).toContain("-line 25");
  });

  it("a new file, a removed file, no change, CRLF", () => {
    expect(unifiedDiff("", "a\nb\n").lines).toEqual(["@@ -0,0 +1,2 @@", "+a", "+b"]);
    expect(unifiedDiff("a\n", "").stat).toEqual({ added: 0, removed: 1 });
    expect(unifiedDiff("a\r\nb\r\n", "a\nb\n").lines).toEqual([]);
    expect(textLines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("a huge middle does not build a huge table", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join("\n");
    const start = Date.now();
    const { stat } = unifiedDiff(a, b);
    expect(stat).toEqual({ added: 5000, removed: 5000 });
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("/diff", () => {
  async function session() {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-diff-"));
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { allow: ["write *", "edit *"] } }));
    await writeFile(path.join(cwd, "README.md"), "# App\noriginal readme\nend\n");
    await writeFile(path.join(cwd, ".env.example"), "x\n");
    const state = await startState(cwd, { local: true, mockJev: true });
    const model = scripted([
      { tool: "write", input: { path: "notes.txt", contents: "first\nsecond\n" } },
      { tool: "edit", input: { path: "README.md", old_string: "original", new_string: "changed" } },
      { text: "turn 1" },
      { tool: "edit", input: { path: "README.md", old_string: "end", new_string: "API_TOKEN=abcdef1234567890" } },
      { text: "turn 2" },
    ]);
    const opts = { mockJev: true, yes: false, local: true, generate: generateWith(model) };
    const run = async (line: string) => (await handleLine(line, state, opts)).output ?? "";
    return { cwd, run };
  }

  it("parses", () => {
    expect(parseLine("/diff stat")).toEqual({ type: "diff", arg: "stat" });
  });

  it("nothing yet, then every change against how the file was before the session", async () => {
    const { run } = await session();
    expect(await run("/diff")).toContain("Nothing changed by the agent in this session yet");
    await run("make notes, fix readme");
    await run("fix the end");
    const out = await run("/diff");
    expect(out).toContain("--- README.md (before this session)");
    expect(out).toContain("-original readme");
    expect(out).toContain("+changed readme");
    expect(out).toContain("+++ notes.txt (now)");
    expect(out).toContain("+first");
    // Secret-looking values are cut, as in any tool output.
    expect(out).not.toContain("abcdef1234567890");
    expect(out).toContain("Shell commands are not tracked");
    const stat = await run("/diff stat");
    expect(stat).toContain("README.md  changed +2 -2");
    expect(stat).toContain("notes.txt  created +2 -0");
    const one = await run("/diff notes.txt");
    expect(one).toContain("+++ notes.txt (now)");
    expect(one).not.toContain("README.md");
    expect(await run("/diff nope.txt")).toContain("No file named nope.txt");
  });
});
