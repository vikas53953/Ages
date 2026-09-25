import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { rewindPoints, rewindTo, snapshotFile } from "../src/checkpoints.ts";
import { loadMessages, sessionDir } from "../src/session.ts";

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

describe("restore points are safe", () => {
  const turn = { at: "2026-09-25T10:00:00.000Z", prompt: "p" };

  it("parallel writes in one step each keep their own file (no seq collision)", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-cp-par-"));
    await writeFile(path.join(cwd, "a.txt"), "A0");
    await writeFile(path.join(cwd, "b.txt"), "B0");
    await Promise.all([snapshotFile(cwd, "s1", turn, "a.txt"), snapshotFile(cwd, "s1", turn, "b.txt")]);
    await writeFile(path.join(cwd, "a.txt"), "A1");
    await writeFile(path.join(cwd, "b.txt"), "B1");
    const result = await rewindTo(cwd, "s1", turn.at, { files: true, chat: false });
    expect(result.restored).toHaveLength(2);
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("A0");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("B0");
  });

  it("a tampered index cannot make rewind write outside the project or into .harness", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-cp-tamper-"));
    const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "aegis-outside-")), "victim.txt");
    await writeFile(outside, "safe");
    await snapshotFile(cwd, "s1", turn, "x.txt"); // creates the checkpoint folder
    const dir = path.join(sessionDir(cwd, "s1"), "checkpoints");
    const forged = [
      { seq: 5, turnAt: turn.at, prompt: "p", file: outside, existed: true },
      { seq: 6, turnAt: turn.at, prompt: "p", file: path.join(cwd, ".harness", "current"), existed: true },
    ];
    await writeFile(path.join(dir, "index.jsonl"), forged.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(path.join(dir, "blobs", "5"), "PWNED");
    await writeFile(path.join(dir, "blobs", "6"), "PWNED");
    const result = await rewindTo(cwd, "s1", turn.at, { files: true, chat: false });
    expect(result.restored).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["outside the project", "inside .git or .harness"]);
    expect(await readFile(outside, "utf8")).toBe("safe");
  });

  it.skipIf(process.platform === "win32")("never keeps or restores through a symlink", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-cp-link-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "aegis-outside-"));
    await writeFile(path.join(outsideDir, "secret.txt"), "SECRET");
    await symlink(outsideDir, path.join(cwd, "linkdir"));
    await symlink(path.join(outsideDir, "secret.txt"), path.join(cwd, "link.txt"));
    await snapshotFile(cwd, "s1", turn, "linkdir/secret.txt");
    await snapshotFile(cwd, "s1", turn, "link.txt");
    expect(await rewindPoints(cwd, "s1")).toEqual([]);
  });

  it("a path that became a folder is reported, and the rest is still restored", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-cp-dir-"));
    await writeFile(path.join(cwd, "x.txt"), "X0");
    await writeFile(path.join(cwd, "y.txt"), "Y0");
    await snapshotFile(cwd, "s1", turn, "x.txt");
    await snapshotFile(cwd, "s1", turn, "y.txt");
    await rm(path.join(cwd, "x.txt"));
    await mkdir(path.join(cwd, "x.txt"));
    await writeFile(path.join(cwd, "y.txt"), "Y1");
    const result = await rewindTo(cwd, "s1", turn.at, { files: true, chat: false });
    expect(result.skipped).toHaveLength(1);
    expect(await readFile(path.join(cwd, "y.txt"), "utf8")).toBe("Y0");
  });

  it("/rewind with chat tells the UI to reload the conversation; /new leaves plan mode", async () => {
    const { state, run } = await project();
    expect((await run("/rewind 1 chat")).chat).toBe("reload");
    expect((await run("/rewind 1 files")).chat).toBeUndefined();
    await run("/plan");
    await run("/new");
    expect(state.planMode).toBe(false);
  });
});

describe("the project folder spelled two ways", () => {
  it.skipIf(process.platform === "win32")("restores when cwd reaches the project through a link (like Windows short 8.3 names)", async () => {
    const real = await mkdtemp(path.join(os.tmpdir(), "aegis-cp-real-"));
    const alias = path.join(await mkdtemp(path.join(os.tmpdir(), "aegis-cp-alias-")), "proj");
    await symlink(real, alias);
    const turn = { at: "2026-09-25T11:00:00.000Z", prompt: "p" };
    await writeFile(path.join(alias, "n.txt"), "N0");
    await snapshotFile(alias, "s1", turn, "n.txt");
    await writeFile(path.join(alias, "n.txt"), "N1");
    const result = await rewindTo(alias, "s1", turn.at, { files: true, chat: false });
    expect(result.skipped).toEqual([]);
    expect(await readFile(path.join(real, "n.txt"), "utf8")).toBe("N0");
  });
});
