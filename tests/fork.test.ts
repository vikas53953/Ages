import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summaryFile } from "../src/compact.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { appendMessage, createSession, loadMessages, messageText, sessionDir } from "../src/session.ts";

const at = () => new Date().toISOString();
const opts = { mockJev: true, yes: false, local: true };

async function conversation() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-fork-"));
  const session = await createSession(cwd);
  for (const [q, a] of [["first question", "first answer"], ["second question", "second answer"], ["third question", "third answer"]]) {
    await appendMessage(cwd, session.id, { role: "user", content: q!, at: at() });
    await appendMessage(cwd, session.id, { role: "assistant", content: a!, at: at() });
  }
  await writeFile(summaryFile(cwd, session.id), "older turns summary");
  await writeFile(path.join(sessionDir(cwd, session.id), "todos.json"), '[{"content":"x","status":"pending"}]');
  await mkdir(path.join(sessionDir(cwd, session.id), "checkpoints"), { recursive: true });
  await writeFile(path.join(sessionDir(cwd, session.id), "checkpoints", "keep.txt"), "restore point");
  const state = await startState(cwd, opts);
  return { cwd, state, original: session.id };
}

describe("/fork", () => {
  it("copies the whole conversation, summary and todos into a new session; the original is untouched", async () => {
    const { cwd, state, original } = await conversation();
    const result = await handleLine("/fork", state, opts);
    expect(result.output).toContain(`/resume ${original}`);
    expect(result.chat).toBe("reload");
    expect(state.session.id).not.toBe(original);
    expect((await loadMessages(cwd, state.session.id)).length).toBe(6);
    expect(await readFile(summaryFile(cwd, state.session.id), "utf8")).toBe("older turns summary");
    expect(await readFile(path.join(sessionDir(cwd, state.session.id), "todos.json"), "utf8")).toContain('"x"');
    expect(await readFile(path.join(sessionDir(cwd, state.session.id), "checkpoints", "keep.txt"), "utf8")).toBe("restore point");
    await handleLine("new direction", state, opts); // continue in the fork
    expect((await loadMessages(cwd, original)).length).toBe(6);
  });

  it("/fork 1 leaves out your last turn, so you can try it another way", async () => {
    const { cwd, state } = await conversation();
    await handleLine("/fork 1", state, opts);
    const rows = await loadMessages(cwd, state.session.id);
    expect(rows.map(messageText)).toEqual(["first question", "first answer", "second question", "second answer"]);
  });

  it("explains bad input", async () => {
    const { state, original } = await conversation();
    expect((await handleLine("/fork 9", state, opts)).output).toContain("only 3 turn(s)");
    expect((await handleLine("/fork two", state, opts)).output).toContain("usage");
    expect(state.session.id).toBe(original);
  });
});

describe("/sessions and /resume <n>", () => {
  it("lists conversations with their first prompt, and a number opens one", async () => {
    const { cwd, state, original } = await conversation();
    await handleLine("/new", state, opts);
    await handleLine("a brand new question", state, opts);
    const list = (await handleLine("/sessions", state, opts)).output;
    expect(list).toMatch(/ 1\. .*a brand new question {2}\(this one\)/);
    expect(list).toMatch(/ 2\. .*first question/);
    expect((await handleLine("/resume", state, opts)).output).toBe(list);
    const opened = await handleLine("/resume 2", state, opts);
    expect(opened.chat).toBe("reload");
    expect(state.session.id).toBe(original);
    expect((await handleLine("/resume 9", state, opts)).output).toContain("No conversation 9");
    void cwd;
  });
});
