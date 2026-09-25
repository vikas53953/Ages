import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BELL_AFTER_MS, bellCommand, loadBell, saveBell, shouldRing } from "../src/bell.ts";
import { parseLine } from "../src/commands.ts";
import { createTuiApp, type TuiApp } from "../src/tui-app.ts";
import { MemoryTerminal } from "../src/tui-memory.ts";

describe("bell", () => {
  const apps: TuiApp[] = [];
  afterEach(() => {
    while (apps.length) apps.pop()?.shutdown();
    saveBell("all");
  });

  it("when to ring", () => {
    expect(shouldRing("all", "ask")).toBe(true);
    expect(shouldRing("done", "ask")).toBe(false);
    expect(shouldRing("all", "done", BELL_AFTER_MS - 1)).toBe(false);
    expect(shouldRing("all", "done", BELL_AFTER_MS)).toBe(true);
    expect(shouldRing("ask", "done", 60_000)).toBe(false);
    expect(shouldRing("off", "ask")).toBe(false);
  });

  it("/bell shows and saves the choice for you", () => {
    expect(parseLine("/bell off")).toEqual({ type: "bell", arg: "off" });
    expect(loadBell()).toBe("all");
    expect(bellCommand("ask")).toContain("Bell: ask");
    expect(loadBell()).toBe("ask");
    expect(bellCommand("loud")).toContain("usage");
    expect(bellCommand(undefined)).toContain("Bell: ask");
  });

  async function app(ask: boolean) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-bell-"));
    const terminal = new MemoryTerminal();
    const tui = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      {
        cwd,
        terminal,
        handleLine: async (_line, state, _opts, confirm = async () => false) => {
          if (ask) await confirm("Aegis: write\n  path: a.txt\n[y/N]");
          return { output: "ok", session: state.session };
        },
      },
    );
    apps.push(tui);
    return { tui, terminal };
  }
  // A bell on its own (escape sequences such as the progress indicator also end in \x07).
  const rang = (terminal: MemoryTerminal) => terminal.writes.some((data) => data === "\x07");

  it("rings when a question waits; not for a quick turn; not when off", async () => {
    const quick = await app(false);
    for (const ch of "hi") quick.tui.feed(ch);
    quick.tui.feed("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(rang(quick.terminal)).toBe(false);

    const asking = await app(true);
    for (const ch of "go") asking.tui.feed(ch);
    asking.tui.feed("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(rang(asking.terminal)).toBe(true);
    asking.tui.feed("n");

    saveBell("off");
    const quiet = await app(true);
    for (const ch of "go") quiet.tui.feed(ch);
    quiet.tui.feed("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(rang(quiet.terminal)).toBe(false);
    quiet.tui.feed("n");
  });
});
