import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

async function project(settings: object = { jev: { mode: "off" } }) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-feel-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify(settings));
  return cwd;
}

/** A model that answers "ok" and keeps what it was offered. */
function recorder(seen: { tools: string[]; system: string }[]) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      seen.push({
        tools: (options.tools ?? []).map((tool) => tool.name),
        system: JSON.stringify(options.prompt.filter((message) => message.role === "system")),
      });
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ] as never[],
        }),
      };
    },
  });
}

describe("shell off", () => {
  it("the model is not offered shell and is told how to list files; with shell on it is offered", async () => {
    const cwd = await project();
    const seen: { tools: string[]; system: string }[] = [];
    delete process.env.AEGIS_ALLOW_SHELL;
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("list the files", state, { mockJev: true, yes: false, local: true, generate: generateWith(recorder(seen)) });
    expect(seen[0]!.tools).toContain("read");
    expect(seen[0]!.tools).not.toContain("shell");
    expect(seen[0]!.system).toContain("There is no shell");
    expect(seen[0]!.system).toContain("List a folder with read (path");

    process.env.AEGIS_ALLOW_SHELL = "1";
    await handleLine("list the files", state, { mockJev: true, yes: false, local: true, generate: generateWith(recorder(seen)) });
    expect(seen[1]!.tools).toContain("shell");
    expect(seen[1]!.system).not.toContain("There is no shell");
  });
});

import { existsSync } from "node:fs";
import { confirmCard } from "../src/confirm-card.ts";
import { describeResult } from "../src/gated.ts";
import { readDraft } from "../src/tool-draft.ts";
import { createTuiApp, type TuiApp } from "../src/tui-app.ts";
import { ConfirmBox } from "../src/tui-confirm.ts";
import { sanitizeText, toolOutcome, toolTitle, turnEndLines } from "../src/tui-layout.ts";
import { MemoryTerminal } from "../src/tui-memory.ts";
import type { ConfirmAnswer, ToolRecord } from "../src/types.ts";

describe("a tool call while the model is still writing it", () => {
  it("reads the path, the line count and the last lines out of half-finished JSON", () => {
    const whole = JSON.stringify({ path: "site/page.jsx", contents: 'line one\n\tline "two"\nline three\nline four\nline five' });
    const half = whole.slice(0, whole.indexOf("line five") + 4);
    const draft = readDraft("write", half);
    expect(draft.path).toBe("site/page.jsx");
    expect(draft.lines).toBe(5);
    expect(draft.tail).toEqual(['\tline "two"', "line three", "line four", "line"]);
    // Cut inside an escape: nothing half-decoded shows.
    expect(readDraft("write", whole.slice(0, whole.indexOf("\\t") + 1)).tail).toEqual(["line one", ""]);
    expect(readDraft("write", '{"pa').path).toBeUndefined();
    expect(readDraft("read", '{"path":"."}')).toEqual({ path: ".", lines: 0, tail: [] });
  });
});

describe("the question card", () => {
  it("says what will happen, in plain words, with the facts that matter", () => {
    const created = confirmCard({ name: "write", args: { path: "site/src/Page.jsx", contents: "a\nb\nc\n" } });
    expect(created).toMatchObject({ title: "Create file", subject: "site/src/Page.jsx", question: "Create Page.jsx?", kind: "code", lines: ["a", "b", "c"] });
    expect(created.facts).toBe("new file · 3 lines · 6 bytes");
    expect(created.reason).toBe("No rule allows this yet, so Aegis asks.");

    const replaced = confirmCard({ name: "write", args: { path: "n.txt", contents: "one\nTWO\n" }, existing: "one\ntwo\n" });
    expect(replaced).toMatchObject({ title: "Overwrite file", question: "Replace all of n.txt?", kind: "diff" });
    expect(replaced.lines).toContain("- two");
    expect(replaced.lines).toContain("+ TWO");

    const edits = confirmCard({ name: "edit", args: { path: "a.ts", edits: JSON.stringify([{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }]) } });
    expect(edits.question).toBe("Make these 2 changes to a.ts?");
    expect(edits.lines).toEqual(expect.arrayContaining(["change 1 of 2", "- x", "+ y", "change 2 of 2"]));

    expect(confirmCard({ name: "shell", args: { command: "Get-ChildItem" } }).question).toBe("Run this PowerShell command?");
    expect(confirmCard({ name: "write", args: { path: "a" }, rule: { rule: "write *", action: "ask" } }).reason).toBe('Your rule "write *" says ask.');
    const scored = confirmCard({ name: "write", args: { path: "a" }, decision: { class: "irreversible", dataLoss: 0.6, confidence: 1, source: "jev" } as never });
    expect(scored.reason).toBe("Jev rates this hard to undo (possible data loss 60%).");
    // Jev without a key says nothing about Jev: it did not score.
    const failed = confirmCard({ name: "write", args: { path: "a" }, decision: { class: "irreversible", dataLoss: 1, confidence: 0, source: "fail_closed" } as never });
    expect(failed.reason).toBe("No rule allows this yet, so Aegis asks.");
  });

  it("starts on No: Enter alone never says yes; 1, 2, y, a, n and esc answer directly", () => {
    const card = confirmCard({ name: "write", args: { path: "a.txt", contents: "x" } });
    const answers: ConfirmAnswer[] = [];
    const box = () => new ConfirmBox("q", (ok) => answers.push(ok), 30, "write a.txt", card);
    box().handleInput("\r");
    box().handleInput("1");
    box().handleInput("2");
    box().handleInput("3");
    box().handleInput("\x1b");
    box().handleInput("y");
    box().handleInput("a");
    const moved = box();
    moved.handleInput("\x1b[A");
    moved.handleInput("\x1b[A");
    moved.handleInput("\r");
    expect(answers).toEqual([false, true, "always", false, false, true, "always", true]);
    const text = sanitizeText(box().render(80).join("\n"));
    expect(text).toContain("❯ 3. No, and tell Aegis what to do instead (esc)");
    expect(text).toContain("2. Yes, and don't ask again for: write a.txt");
  });

  it("draws what the model wrote as text: escape codes in a file cannot paint fake lines", () => {
    const card = confirmCard({ name: "write", args: { path: "evil.txt", contents: "ok\n\x1b[2K\x1b[1A  1. Yes (safe)\x1b]8;;https://evil\x07" } });
    const drawn = new ConfirmBox("q", () => {}, 30, undefined, card).render(80).join("\n");
    expect(drawn).not.toContain("\x1b[2K");
    expect(drawn).not.toContain("\x1b[1A");
    expect(drawn).not.toContain("https://evil");
  });
});

describe("what a turn leaves in the chat", () => {
  const record = (extra: Partial<ToolRecord>): ToolRecord => ({ name: "write", class: "irreversible", dataLoss: 1, confidence: 1, action: "confirm", approved: true, ...extra });

  it("tool lines say what happened, not which part of the lock decided", () => {
    expect(toolTitle("write", "src/App.jsx")).toBe("Write(src/App.jsx)");
    expect(toolTitle("read", ".")).toBe("List(.)");
    expect(toolTitle("grep", "runLoop")).toBe("Search(runLoop)");
    const cwd = os.tmpdir();
    expect(describeResult("write", { path: "x", contents: "a\nb\n" }, "ok", undefined, cwd)).toMatchObject({ summary: "Created · 2 lines", created: true, preview: ["a", "b", ""] });
    expect(describeResult("write", { path: "x", contents: "a\n" }, "ok", "a\nb\nc\n", cwd).summary).toBe("Replaced · 3 → 1 line");
    expect(describeResult("write", { path: "x", contents: "password=Sup3rS3cretPass\n" }, "ok", undefined, cwd).preview?.[0]).not.toContain("Sup3rS3cretPass");
    expect(toolOutcome(record({ summary: "Created · 2 lines" }))).toBe("Created · 2 lines");
    expect(toolOutcome(record({ approved: false, deniedReason: "user declined" }))).toBe("You said no");
    expect(toolOutcome(record({ approved: false, deniedReason: "rule: write .env" }))).toBe('Blocked by your rule "write .env"');
    expect(toolOutcome(record({ summary: "Read · 3 lines", redacted: 2 }))).toBe("Read · 3 lines · 2 secrets hidden from the model");
  });

  it("the turn ends with the full path of each file it made, as a link the terminal opens", () => {
    const cwd = path.join(os.tmpdir(), "proj");
    const lines = turnEndLines(
      {
        outcome: "completed",
        ms: 160_000,
        model: "glm-5.3-flash",
        text: "",
        tools: [
          { name: "write", approved: true, target: "site/page.html", created: true },
          { name: "edit", approved: true, target: "README.md" },
          { name: "write", approved: false, target: "denied.txt" },
        ],
      },
      cwd,
    );
    const plain = lines.map((line) => sanitizeText(line));
    expect(plain[0]).toBe("  ✓ Done in 2m 40s · created 1 file, changed 1 file");
    expect(plain[1]).toBe(`    ${path.join(cwd, "site/page.html")}`);
    expect(lines[1]).toContain(`\x1b]8;;file://`);
    expect(plain.join("\n")).not.toContain("denied.txt");
    expect(plain.at(-1)).toContain("ctrl+click a path to open it");
  });
});

/** A model that writes one file, streaming the call in many small pieces like a real one, then answers. */
function writer(contents: string, calls: { count: number }) {
  const json = JSON.stringify({ path: "site/page.jsx", contents });
  const pieces: object[] = [{ type: "tool-input-start", id: "w1", toolName: "write" }];
  for (let at = 0; at < json.length; at += 40) pieces.push({ type: "tool-input-delta", id: "w1", delta: json.slice(at, at + 40) });
  pieces.push({ type: "tool-input-end", id: "w1" }, { type: "tool-call", toolCallId: "w1", toolName: "write", input: json });
  return new MockLanguageModelV4({
    doStream: async () => {
      calls.count += 1;
      const chunks =
        calls.count === 1
          ? [{ type: "stream-start", warnings: [] }, ...pieces, { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage }]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "Made the page." },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks: chunks as never[], chunkDelayInMs: calls.count === 1 ? 8 : 0 }) };
    },
  });
}

describe("the terminal, end to end (a fake model writing a page)", () => {
  const apps: TuiApp[] = [];
  afterEach(() => {
    while (apps.length) apps.pop()?.shutdown();
  });

  async function start(calls: { count: number }) {
    const cwd = await project();
    process.env.AEGIS_HOME = path.join(cwd, ".home");
    const contents = Array.from({ length: 60 }, (_, index) => `<p>line ${index + 1}</p>`).join("\n");
    const terminal = new MemoryTerminal();
    terminal.columns = 100;
    terminal.rows = 30;
    const app = await createTuiApp({ mockJev: true, yes: false, local: true, generate: generateWith(writer(contents, calls)) }, { cwd, terminal });
    apps.push(app);
    for (const ch of "make the page") app.feed(ch);
    app.feed("\r");
    return { app, cwd };
  }

  const screen = (app: TuiApp) => [app.transcriptText(), app.statusText(), app.confirmBoxText()].join("\n");
  async function until(app: TuiApp, check: (text: string) => boolean, ms = 8000) {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const text = screen(app);
      if (check(text)) return text;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`screen never matched:\n${screen(app)}`);
  }

  it("shows the file growing, asks with a card, and ends with a link to the file", async () => {
    const calls = { count: 0 };
    const { app, cwd } = await start(calls);
    const writing = await until(app, (text) => /writing… \d+ lines/.test(text));
    expect(writing).toContain("Write(site/page.jsx)");
    expect(writing).toMatch(/Writing page\.jsx… \d+s · [\d.]+ (KB|chars) · esc to stop/);
    const card = await until(app, (text) => text.includes("Create page.jsx?"));
    expect(card).toContain("new file · 60 lines");
    expect(card).toContain("❯ 3. No, and tell Aegis what to do instead");
    app.feed("1");
    const after = await until(app, (text) => text.includes("Done in"));
    expect(after).toContain("⎿  Created · 60 lines");
    expect(after).not.toContain("waiting for your y/N");
    expect(existsSync(path.join(cwd, "site", "page.jsx"))).toBe(true);
    expect(app.messages().join("\n")).toContain(path.join(cwd, "site", "page.jsx"));
  }, 20_000);

  it("No stops the turn and waits for what to do instead", async () => {
    const calls = { count: 0 };
    const { app, cwd } = await start(calls);
    await until(app, (text) => text.includes("Create page.jsx?"));
    app.feed("\x1b");
    const after = await until(app, (text) => text.includes("Stopped after"));
    expect(after).toContain("⎿  You said no");
    expect(after).toContain("Stopped because you said no. Tell Aegis what to do instead.");
    expect(calls.count).toBe(1);
    expect(existsSync(path.join(cwd, "site", "page.jsx"))).toBe(false);
  }, 20_000);
});
