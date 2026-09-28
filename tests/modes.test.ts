import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { modeAllows, runGatedTool } from "../src/gated.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { footerText, toolOutcome } from "../src/tui-layout.ts";
import type { JsonObject, PermissionMode, ToolDecision } from "../src/types.ts";

const jevOff = (): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), jev: { mode: "off" } });

/** One call through the lock in a mode: was it asked, did it run, and what does the record say. */
async function call(name: string, args: JsonObject, mode: PermissionMode | (() => PermissionMode | undefined) | undefined, extra: { settings?: Settings; decision?: ToolDecision } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-mode-"));
  let asked = false;
  let ran = false;
  const run = await runGatedTool({
    name,
    args,
    cwd,
    mode,
    config: loadConfig(),
    settings: extra.settings ?? jevOff(),
    jev: extra.decision
      ? { evaluateTurn: async () => ({}) as never, evaluateTool: async () => extra.decision! }
      : undefined,
    confirm: async () => {
      asked = true;
      return false;
    },
    execute: async () => {
      ran = true;
      return "done";
    },
  });
  return { asked, ran, record: run.record };
}

describe("approval modes", () => {
  it("which tools each mode lets run when no rule matched", () => {
    expect(modeAllows(undefined, "write")).toBe(false);
    expect(modeAllows("ask", "write")).toBe(false);
    expect(["write", "edit", "shell", "webfetch", "agent"].map((name) => modeAllows("auto", name))).toEqual([true, true, false, false, false]);
    expect(["write", "shell", "webfetch", "agent", "mcp_thing"].every((name) => modeAllows("yolo", name))).toBe(true);
  });

  it("ask (the default) asks; auto runs a new file without asking and says so", async () => {
    const asked = await call("write", { path: "a.txt", contents: "x" }, undefined);
    expect(asked).toMatchObject({ asked: true, ran: false });
    const auto = await call("write", { path: "a.txt", contents: "x" }, "auto");
    expect(auto).toMatchObject({ asked: false, ran: true });
    expect(auto.record).toMatchObject({ approved: true, source: "mode", mode: "auto" });
    expect(toolOutcome(auto.record)).toContain("auto mode");
  });

  it("auto still asks for everything that is not a file change", async () => {
    expect(await call("webfetch", { url: "https://example.com" }, "auto")).toMatchObject({ asked: true, ran: false });
    expect(await call("agent", { name: "fixer", task: "x" }, "auto")).toMatchObject({ asked: true, ran: false });
  });

  it("yolo runs what no rule covers, and says so", async () => {
    const yolo = await call("webfetch", { url: "https://example.com" }, "yolo");
    expect(yolo).toMatchObject({ asked: false, ran: true });
    expect(yolo.record).toMatchObject({ source: "mode", mode: "yolo" });
    expect(toolOutcome(yolo.record)).toContain("YOLO");
  });

  it("in yolo, deny rules still block and ask rules (memory, .aegis, deletes) still ask", async () => {
    expect(await call("write", { path: ".git/config", contents: "x" }, "yolo")).toMatchObject({ asked: false, ran: false });
    expect(await call("remember", { note: "likes tabs" }, "yolo")).toMatchObject({ asked: true, ran: false });
    expect(await call("write", { path: ".aegis/settings.json", contents: "{}" }, "yolo")).toMatchObject({ asked: true, ran: false });
    expect(await call("shell", { command: "Remove-Item x" }, "yolo")).toMatchObject({ asked: true, ran: false });
    const mine = jevOff();
    mine.rules.ask = [...mine.rules.ask, "write secrets/*"];
    expect(await call("write", { path: "secrets/a.txt", contents: "x" }, "yolo", { settings: mine })).toMatchObject({ asked: true, ran: false });
  });

  it("in yolo, Jev can still make a call ask when it really scored; a Jev that could not score does not", async () => {
    const everyCall = { ...structuredClone(DEFAULT_SETTINGS), jev: { mode: "every-call" as const } };
    const risky: ToolDecision = { class: "irreversible", dataLoss: 1, confidence: 1, source: "jev" } as ToolDecision;
    const scored = await call("write", { path: "a.txt", contents: "x" }, "yolo", { settings: everyCall, decision: risky });
    expect(scored.ran).toBe(false);
    const blind: ToolDecision = { class: "irreversible", dataLoss: 1, confidence: 0, source: "fail_closed" } as ToolDecision;
    expect(await call("write", { path: "a.txt", contents: "x" }, "yolo", { settings: everyCall, decision: blind })).toMatchObject({ asked: false, ran: true });
    // In ask mode, a Jev that could not score still asks (AGENTS.md).
    expect(await call("write", { path: "a.txt", contents: "x" }, "ask", { settings: everyCall, decision: blind })).toMatchObject({ asked: true });
  });

  it("/yolo warns and needs 'yes'; /mode switches; /status shows it; nothing is saved", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-mode-cmd-"));
    const opts = { mockJev: true, yes: false, local: true };
    const state = await startState(cwd, opts);
    expect((await handleLine("/yolo", state, opts)).output).toContain("Type /yolo yes to turn it on.");
    expect(state.permissionMode ?? "ask").toBe("ask");
    await handleLine("/yolo yes", state, opts);
    expect(state.permissionMode).toBe("yolo");
    expect((await handleLine("/status", state, opts)).output).toMatch(/mode {6}yolo/);
    await handleLine("/yolo off", state, opts);
    expect(state.permissionMode).toBe("ask");
    await handleLine("/mode auto", state, opts);
    expect(state.permissionMode).toBe("auto");
    expect((await handleLine("/mode yolo", state, opts)).output).toContain("Type /yolo yes");
    expect(state.permissionMode).toBe("auto");
    // A new session starts in ask.
    expect((await startState(cwd, opts)).permissionMode ?? "ask").toBe("ask");
  });
});

describe("approval modes: review fixes", () => {
  it("files that steer later turns or run code by themselves still ask in auto and yolo", async () => {
    for (const file of ["AGENTS.md", "AGENTS.local.md", "HARNESS.md", ".envrc", ".vscode/tasks.json", ".husky/pre-commit", ".github/workflows/ci.yml"]) {
      expect(await call("write", { path: file, contents: "x" }, "yolo"), file).toMatchObject({ asked: true, ran: false });
      expect(await call("edit", { path: file, old_string: "a", new_string: "b" }, "auto"), file).toMatchObject({ asked: true, ran: false });
    }
    expect(await call("write", { path: "src/App.jsx", contents: "x" }, "auto")).toMatchObject({ asked: false, ran: true });
  });

  it("the mode is read on every call: turning yolo off counts from the next step", async () => {
    let mode: PermissionMode = "yolo";
    const live = () => mode;
    expect(await call("webfetch", { url: "https://example.com" }, live)).toMatchObject({ asked: false, ran: true });
    mode = "ask";
    expect(await call("webfetch", { url: "https://example.com" }, live)).toMatchObject({ asked: true, ran: false });
  });

  it("only an exact /yolo yes turns it on; a new, resumed or forked conversation starts in ask", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-mode-exact-"));
    const opts = { mockJev: true, yes: false, local: true };
    const state = await startState(cwd, opts);
    for (const line of ["/yolo yes please", "/yolo yes\nnow summarise the repo", "/yolo y"]) {
      expect((await handleLine(line, state, opts)).output).toContain("Type /yolo yes");
      expect(state.permissionMode ?? "ask").toBe("ask");
    }
    await handleLine("/yolo yes", state, opts);
    expect(state.permissionMode).toBe("yolo");
    await handleLine("/new", state, opts);
    expect(state.permissionMode).toBe("ask");
    await handleLine("/mode auto", state, opts);
    await handleLine("/fork", state, opts);
    expect(state.permissionMode).toBe("ask");
  });

  it("the footer leads with the mode tags, both when plan and yolo are on", () => {
    const text = footerText({ modelMode: "auto", model: "auto", jev: "off", provider: "local", plan: true, mode: "yolo", cwd: "C:/a/very/long/path/that/goes/on" });
    const plain = text.replace(/\x1b\[[\d;]*m/g, "");
    expect(plain.startsWith("PLAN · YOLO · C:/a/very/long")).toBe(true);
    expect(footerText({ modelMode: "auto", model: "auto", jev: "off", provider: "local", mode: "auto" }).startsWith("AUTO · ")).toBe(true);
  });
});
