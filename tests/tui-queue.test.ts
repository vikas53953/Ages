import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleLine, startState } from "../src/runtime.ts";
import { appendMessage, createSession } from "../src/session.ts";
import { createTuiApp, type TuiApp } from "../src/tui-app.ts";
import { MemoryTerminal } from "../src/tui-memory.ts";

const apps: TuiApp[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.shutdown();
});

async function until(check: () => boolean, ms = 5000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe("TUI: typing while a turn runs", () => {
  it("queues the message and sends it after the turn; Esc puts queued messages back in the editor", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-q-"));
    const handled: string[] = [];
    let release: () => void = () => {};
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      {
        cwd,
        terminal: new MemoryTerminal(),
        handleLine: async (line, state, opts) => {
          handled.push(line);
          if (line === "first") {
            await new Promise<void>((resolve) => {
              release = resolve;
              opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          return { output: `done ${line}`, session: state.session };
        },
      },
    );
    apps.push(app);
    for (const ch of "first") app.feed(ch);
    app.feed("\r");
    await until(() => handled.length === 1);
    for (const ch of "second") app.feed(ch);
    app.feed("\r");
    await until(() => app.lines().join("\n").includes("queued: second"));
    expect(handled).toEqual(["first"]); // not sent yet
    release();
    await until(() => handled.length === 2);
    expect(handled).toEqual(["first", "second"]);

    // Esc during a turn: queued text comes back to the editor instead of running.
    for (const ch of "first") app.feed(ch);
    app.feed("\r");
    await until(() => handled.length === 3);
    for (const ch of "later") app.feed(ch);
    app.feed("\r");
    await until(() => app.lines().join("\n").includes("queued: later"));
    app.feed("\x1b");
    await until(() => app.editor.getText() === "later");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handled).toEqual(["first", "second", "first"]);
  }, 20_000);

  it("shift+tab turns plan mode on and off", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-plan-"));
    const app = await createTuiApp({ mockJev: true, yes: false, local: true }, { cwd, terminal: new MemoryTerminal() });
    apps.push(app);
    app.feed("\x1b[Z"); // shift+tab
    await until(() => app.lines().join("\n").includes("PLAN ·"));
    app.feed("\x1b[Z");
    await until(() => !app.lines().join("\n").includes("PLAN ·"));
  });
});

describe("/export and /copy", () => {
  it("saves the conversation as Markdown or JSONL", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-export-"));
    const session = await createSession(cwd);
    await appendMessage(cwd, session.id, { role: "user", content: "hello", at: new Date().toISOString() });
    await appendMessage(cwd, session.id, { role: "assistant", content: "hi there", at: new Date().toISOString() });
    const state = await startState(cwd, { local: true, mockJev: true });
    const opts = { mockJev: true, yes: false, local: true };
    const md = (await handleLine("/export", state, opts)).output;
    expect(md).toContain("Saved 2 message(s)");
    const mdFile = md.split(" to ")[1]!.trim();
    expect(await readFile(mdFile, "utf8")).toBe("## You\n\nhello\n\n## Aegis\n\nhi there\n");
    const jsonl = (await handleLine("/export jsonl", state, opts)).output;
    const rows = (await readFile(jsonl.split(" to ")[1]!.trim(), "utf8")).trim().split("\n");
    expect(rows).toHaveLength(2);
  });

  it("/copy copies the last answer, or says the clipboard could not be reached", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-copy-"));
    const session = await createSession(cwd);
    await appendMessage(cwd, session.id, { role: "assistant", content: "hi there", at: new Date().toISOString() });
    const state = await startState(cwd, { local: true, mockJev: true });
    const copy = (await handleLine("/copy", state, { mockJev: true, yes: false, local: true })).output;
    expect(copy === "Copied the last answer." || copy.includes("Could not reach the clipboard")).toBe(true);
  }, 30_000); // Windows starts PowerShell for Set-Clipboard
});
