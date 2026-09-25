import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTuiApp, type TuiApp } from "../src/tui-app.ts";
import { MemoryTerminal } from "../src/tui-memory.ts";
import { handleLine, jevHealthFromReceipt, startState, type HandleResult } from "../src/runtime.ts";
import type { Receipt } from "../src/types.ts";
import { createSession, appendMessage } from "../src/session.ts";
import { ConfirmBox } from "../src/tui-confirm.ts";

async function waitFor(app: TuiApp, needle: string, ms = 4000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const text = [app.messages().join("\n"), app.confirmText(), app.lines().join("\n")].join("\n");
    if (text.includes(needle)) return text;
    app.tui.renderNow(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(
    `missing ${JSON.stringify(needle)}\nMESSAGES:\n${app.messages().join("\n")}\nCONFIRM:\n${app.confirmText()}\nSCREEN:\n${app.lines().join("\n")}`,
  );
}

describe("TUI app", () => {
  const apps: TuiApp[] = [];

  afterEach(() => {
    while (apps.length) apps.pop()?.shutdown();
  });

  it("keeps typed text, arrows, Home/End, and backspace in the editor", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-edit-"));
    const terminal = new MemoryTerminal();
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      { cwd, terminal, handleLine: async (_line, state) => ({ output: "ok", session: state.session }) },
    );
    apps.push(app);
    for (const ch of "abcd") app.feed(ch);
    expect(app.editor.getText()).toBe("abcd");
    app.feed("\x1b[D");
    app.feed("\x1b[D");
    app.feed("X");
    expect(app.editor.getText()).toBe("abXcd");
    app.feed("\x1b[H");
    app.feed("Z");
    expect(app.editor.getText()).toBe("ZabXcd");
    app.feed("\x1b[F");
    app.feed("\x7f");
    expect(app.editor.getText()).toBe("ZabXc");
    const screen = app.lines().join("\n");
    expect(screen).toContain("ZabXc");
    expect(screen).toContain("auto · jev mock");
  });

  it("inserts a multiline paste without submitting", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-paste-"));
    const terminal = new MemoryTerminal();
    const submitted: string[] = [];
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      {
        cwd,
        terminal,
        handleLine: async (line, state) => {
          submitted.push(line);
          return { output: "ran", session: state.session };
        },
      },
    );
    apps.push(app);
    app.feed("\x1b[200~hello\nworld\x1b[201~");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(submitted).toEqual([]);
    expect(app.editor.getExpandedText()).toMatch(/hello/);
    expect(app.lines().join("\n")).not.toContain("› hello");
  });

  it("submits on Enter and shows the reply", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-enter-"));
    const terminal = new MemoryTerminal();
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      {
        cwd,
        terminal,
        handleLine: async (line, state) => ({
          output: `echo:${line}`,
          session: state.session,
        }),
      },
    );
    apps.push(app);
    for (const ch of "ping") app.feed(ch);
    app.feed("\r");
    const text = await waitFor(app, "echo:ping");
    expect(text).toContain("echo:ping");
    expect(app.messages()).toContain("ping");
    expect(app.messages().join("\n")).toContain("echo:ping");
  });

  it("does not duplicate the header on resize", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-resize-"));
    const terminal = new MemoryTerminal();
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      { cwd, terminal, handleLine: async (_line, state) => ({ output: "", session: state.session }) },
    );
    apps.push(app);
    terminal.resize(100, 30);
    app.tui.requestRender(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const matches = app.lines().join("\n").match(/Aegis v\d/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("queues confirms, shows the action, and defaults Enter to No", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-ask-"));
    const terminal = new MemoryTerminal();
    const answers: Array<boolean | "always"> = [];
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      {
        cwd,
        terminal,
        handleLine: async (_line, state, _opts, confirm = async () => false) => {
          answers.push(await confirm("Aegis: write\n  path: note.txt\n  contents: secret-body\n[y/N]"));
          answers.push(await confirm("Aegis: edit\n  path: other.txt\n[y/N]"));
          return { output: `done:${answers.join(",")}`, session: state.session };
        },
      },
    );
    apps.push(app);
    app.feed("g");
    app.feed("o");
    app.feed("\r");
    await waitFor(app, "secret-body");
    app.feed("\r");
    await waitFor(app, "other.txt");
    app.feed("y");
    const text = await waitFor(app, "done:false,true");
    expect(text).toContain("done:false,true");
    expect(answers).toEqual([false, true]);
  });

  it("reloads the transcript on /new and /resume", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-sess-"));
    const first = await createSession(cwd);
    await appendMessage(cwd, first.id, {
      role: "user",
      content: "old-turn",
      at: new Date().toISOString(),
    });
    await appendMessage(cwd, first.id, {
      role: "assistant",
      content: "old-reply",
      at: new Date().toISOString(),
    });
    const terminal = new MemoryTerminal();
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      { cwd, terminal },
    );
    apps.push(app);
    await waitFor(app, "old-turn");
    for (const ch of "/new") app.feed(ch);
    app.feed("\r");
    const cleared = await waitFor(app, "new session");
    expect(cleared).not.toContain("old-turn");
    for (const ch of `/resume ${first.id}`) app.feed(ch);
    app.feed("\r");
    const restored = await waitFor(app, "old-reply");
    expect(restored).toContain("old-turn");
    expect(restored).toContain("resumed");
    // Three screen waits of up to 4 s each: more than Vitest's 5 s default on a busy machine.
  }, 20_000);

  it("reloads a session with tool calls: shows the text, hides raw tool rows", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-tools-"));
    const first = await createSession(cwd);
    const at = new Date().toISOString();
    await appendMessage(cwd, first.id, { role: "user", content: "read-the-notes", at });
    await appendMessage(cwd, first.id, {
      role: "assistant",
      at,
      content: [
        { type: "text", text: "reading-now" },
        { type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "n.txt" } },
      ],
    });
    await appendMessage(cwd, first.id, {
      role: "tool",
      at,
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "RAW-TOOL-OUTPUT" } }],
    });
    await appendMessage(cwd, first.id, { role: "assistant", at, content: [{ type: "text", text: "notes-summary" }] });
    const terminal = new MemoryTerminal();
    const app = await createTuiApp({ mockJev: true, yes: false, local: true }, { cwd, terminal });
    apps.push(app);
    const text = await waitFor(app, "notes-summary");
    expect(text).toContain("read-the-notes");
    expect(text).toContain("reading-now");
    expect(text).not.toContain("RAW-TOOL-OUTPUT");
  });

  it("cancels a pending approval on Ctrl+C without running the tool", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-cancel-"));
    const terminal = new MemoryTerminal();
    let executed = false;
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      {
        cwd,
        terminal,
        handleLine: async (_line, state, _opts, confirm = async () => false) => {
          const ok = await confirm("Aegis: write\n  contents: secret-payload\n[y/N]");
          if (ok) executed = true;
          return { output: `answer:${ok}`, session: state.session };
        },
      },
    );
    apps.push(app);
    app.feed("g");
    app.feed("o");
    app.feed("\r");
    await waitFor(app, "secret-payload");
    app.feed("\x03");
    const text = await waitFor(app, "answer:false");
    expect(executed).toBe(false);
    expect(text).toContain("answer:false");
  });

  it("keeps a long /models list in the scrollable transcript", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-tui-models-"));
    const terminal = new MemoryTerminal();
    terminal.rows = 12;
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      { cwd, terminal },
    );
    apps.push(app);
    for (const ch of "/models") app.feed(ch);
    app.feed("\r");
    const text = await waitFor(app, "kimi-k2.7-code");
    expect(app.messages().join("\n")).toContain("glm-5.3");
  });
});

describe("ConfirmBox", () => {
  it("ignores pasted blobs and treats Enter as No", () => {
    const seen: Array<boolean | "always"> = [];
    const box = new ConfirmBox("Aegis: write\n  path: x", (ok) => seen.push(ok));
    box.handleInput("\x1b[200~y\ny\x1b[201~");
    expect(seen).toEqual([]);
    box.handleInput("\r");
    expect(seen).toEqual([false]);
  });

  it("keeps a long payload inspectable by scrolling", () => {
    const payload = `HEAD${"m".repeat(400)}TAIL`;
    const box = new ConfirmBox(`Aegis: write\n  contents: ${payload}`, () => undefined, 12);
    const first = box.render(28).join("\n");
    expect(first).toContain("HEAD");
    expect(first).not.toContain("TAIL");
    box.handleInput("\x1b[F");
    expect(box.render(28).join("\n")).toContain("TAIL");
  });
});

describe("runtime chat flags", () => {
  it("marks /new as reset and /resume as reload", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-chat-flag-"));
    const state = await startState(cwd, { local: true });
    const created = await handleLine("/new", state, { mockJev: true, yes: true, local: true });
    expect(created.chat).toBe("reset");
    const resumed: HandleResult = await handleLine(`/resume ${created.session.id}`, state, {
      mockJev: true,
      yes: true,
      local: true,
    });
    expect(resumed.chat).toBe("reload");
  });

  it("does not call Jev live after a fail-closed score, and key presence is not live", () => {
    const previous = {
      typesafe: process.env.TYPESAFE_API_KEY,
      typesafeAi: process.env.TYPESAFE_AI_API_KEY,
      gateway: process.env.AI_GATEWAY_API_KEY,
    };
    process.env.TYPESAFE_API_KEY = "test-key";
    try {
      const down = { turn: { source: "fail_closed" }, tools: [] } as unknown as Receipt;
      const live = { turn: { source: "jev" }, tools: [] } as unknown as Receipt;
      expect(jevHealthFromReceipt(false, down)).toBe("down");
      expect(jevHealthFromReceipt(false, live)).toBe("live");
    } finally {
      if (previous.typesafe === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous.typesafe;
    }
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_AI_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      const claimed = { turn: { source: "jev" }, tools: [] } as unknown as Receipt;
      expect(jevHealthFromReceipt(false, claimed)).toBe("blocked");
    } finally {
      if (previous.typesafe !== undefined) process.env.TYPESAFE_API_KEY = previous.typesafe;
      if (previous.typesafeAi !== undefined) process.env.TYPESAFE_AI_API_KEY = previous.typesafeAi;
      if (previous.gateway !== undefined) process.env.AI_GATEWAY_API_KEY = previous.gateway;
    }
  });
});
