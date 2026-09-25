import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { loadMessages } from "../src/session.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type Step = { tool: string; input: object } | { text: string };

/** Each model call takes the next step. */
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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-rewind-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { allow: ["read *", "grep *", "write *", "edit *"] } }));
  await writeFile(path.join(cwd, "README.md"), "original readme\n");
  const state = await startState(cwd, { local: true, mockJev: true });
  // Three turns: 1 creates notes.txt and edits README; 2 edits notes.txt; 3 edits it again.
  const model = scripted([
    { tool: "write", input: { path: "notes.txt", contents: "v1" } },
    { tool: "edit", input: { path: "README.md", old_string: "original", new_string: "changed" } },
    { text: "turn 1 done" },
    { tool: "write", input: { path: "notes.txt", contents: "v2" } },
    { text: "turn 2 done" },
    { tool: "write", input: { path: "notes.txt", contents: "v3" } },
    { tool: "write", input: { path: "notes.txt", contents: "v3b" } },
    { text: "turn 3 done" },
  ]);
  const opts = { mockJev: true, yes: false, local: true, generate: generateWith(model) };
  const run = async (line: string) => {
    const result = await handleLine(line, state, opts);
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct turn timestamps
    return result;
  };
  await run("create notes and fix the readme");
  await run("update the notes");
  await run("update the notes again");
  const read = (file: string) => readFile(path.join(cwd, file), "utf8");
  return { cwd, state, opts, run, read };
}

describe("/rewind", () => {
  it("lists turns that changed files, newest first", async () => {
    const { run } = await project();
    const list = (await run("/rewind")).output;
    const lines = list.split("\n").filter((line) => /^\s+\d+\s/.test(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("update the notes again");
    expect(lines[2]).toContain("create notes and fix the readme");
    expect(lines[2]).toContain("README.md");
  });

  it("puts files back to before a turn: the first change in a turn is what it undoes to", async () => {
    const { run, read } = await project();
    expect(await read("notes.txt")).toBe("v3b");
    const result = await run("/rewind 1 files");
    expect(result.output).toContain("restored  notes.txt");
    expect(await read("notes.txt")).toBe("v2"); // not v3: the turn wrote twice, it undoes both
    // Now turn 2 is the newest point.
    expect((await run("/rewind")).output.split("\n")[2]).toContain('"update the notes"');
  });

  it("rewinding to the first turn restores edited files and removes files that did not exist", async () => {
    const { cwd, run, read } = await project();
    const result = await run("/rewind 3 files");
    expect(result.output).toContain("removed   notes.txt");
    expect(existsSync(path.join(cwd, "notes.txt"))).toBe(false);
    expect(await read("README.md")).toBe("original readme\n");
    expect((await run("/rewind")).output).toContain("No restore points yet");
  });

  it("'chat' drops the conversation from that turn on and leaves files alone; the default does both", async () => {
    const { cwd, state, run, read } = await project();
    const before = await loadMessages(cwd, state.session.id);
    expect(before.filter((row) => row.role === "user")).toHaveLength(3);
    const chat = await run("/rewind 1 chat");
    expect(chat.output).toMatch(/conversation: \d+ message\(s\) dropped/);
    expect(await read("notes.txt")).toBe("v3b");
    const after = await loadMessages(cwd, state.session.id);
    expect(after.filter((row) => row.role === "user").map((row) => row.content)).toEqual(["create notes and fix the readme", "update the notes"]);
    const both = await run("/rewind 2");
    expect(both.output).toContain("restored  notes.txt");
    expect(await read("notes.txt")).toBe("v1");
    expect((await loadMessages(cwd, state.session.id)).filter((row) => row.role === "user")).toHaveLength(1);
  });

  it("explains bad input", async () => {
    const { run } = await project();
    expect((await run("/rewind 9")).output).toContain("usage: /rewind <1-3>");
    expect((await run("/rewind 1 everything")).output).toContain("usage");
    expect((await run("/undo")).output).toContain("Restore points");
  });
});
