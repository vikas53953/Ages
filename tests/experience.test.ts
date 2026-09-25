import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { loadMessages, messageText } from "../src/session.ts";
import { createTuiApp } from "../src/tui-app.ts";
import { MemoryTerminal } from "../src/tui-memory.ts";

const savedShell = process.env.AEGIS_POWERSHELL;
afterEach(() => {
  if (savedShell === undefined) delete process.env.AEGIS_POWERSHELL;
  else process.env.AEGIS_POWERSHELL = savedShell;
});

/** On Windows the real PowerShell runs. Elsewhere a stand-in prints what PowerShell would. */
async function usePowerShell() {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(path.join(os.tmpdir(), "fake-pwsh-"));
  const fake = path.join(dir, "pwsh");
  await writeFile(fake, '#!/bin/sh\n# args: -NoProfile -NonInteractive -Command "<cmd>"\necho "$4" | sed "s/^Write-Output //"\n');
  await chmod(fake, 0o755);
  process.env.AEGIS_POWERSHELL = fake;
}

describe("! runs PowerShell yourself", () => {
  it("shows the output and adds it to the chat; !! leaves the chat alone", async () => {
    await usePowerShell();
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-bang-"));
    const state = await startState(cwd, { local: true, mockJev: true });
    const opts = { mockJev: true, yes: false, local: true };
    const shown = await handleLine("!Write-Output hello-bang", state, opts);
    expect(shown.output).toContain("✓ Write-Output hello-bang");
    expect(shown.output).toContain("hello-bang");
    let rows = await loadMessages(cwd, state.session.id);
    expect(rows).toHaveLength(1);
    expect(messageText(rows[0]!)).toContain("I ran this PowerShell command myself");
    expect(messageText(rows[0]!)).toContain("hello-bang");
    const quiet = await handleLine("!!Write-Output quiet-bang", state, opts);
    expect(quiet.output).toContain("not added to the chat");
    rows = await loadMessages(cwd, state.session.id);
    expect(rows).toHaveLength(1);
  });
});

describe("sessions per launch", () => {
  it("starts a new session with newSession, continues the last one without it", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-launch-"));
    const first = await startState(cwd, { local: true, mockJev: true, newSession: true });
    const second = await startState(cwd, { local: true, mockJev: true, newSession: true });
    expect(second.session.id).not.toBe(first.session.id);
    const continued = await startState(cwd, { local: true, mockJev: true });
    expect(continued.session.id).toBe(second.session.id);
  });

  it("parses -c, -v, -h and -m like the long flags", () => {
    expect(parseArgs(["-c"])).toMatchObject({ continue: true, prompt: "" });
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["-m", "glm-5.3", "hi", "there"])).toMatchObject({ model: "glm-5.3", prompt: "hi there" });
    expect(parseArgs(["help me fix the build"])).toMatchObject({ help: false, prompt: "help me fix the build" });
  });
});

describe("TUI keys", () => {
  it("needs ctrl+c twice to exit, and the first press only warns", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-keys-"));
    const terminal = new MemoryTerminal();
    const app = await createTuiApp({ mockJev: true, yes: false, local: true }, { cwd, terminal });
    let exited = false;
    void app.finished.then(() => {
      exited = true;
    });
    app.feed("\x03");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exited).toBe(false);
    expect(terminal.writes.join("")).toContain("Press ctrl+c again to exit");
    app.feed("\x03");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exited).toBe(true);
  });

  it("first ctrl+c clears typed text instead of exiting", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-keys2-"));
    const terminal = new MemoryTerminal();
    const app = await createTuiApp({ mockJev: true, yes: false, local: true }, { cwd, terminal });
    for (const ch of "draft") app.feed(ch);
    app.feed("\x03");
    expect(app.editor.getText()).toBe("");
    app.shutdown();
  });
});
