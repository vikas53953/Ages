import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfirm } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { runGatedTool } from "../src/gated.ts";
import { DEFAULT_SETTINGS, loadSettings, saveAllowRule, settingsPath, suggestAllowRule } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { loadUserTheme, on, setTheme, themeName } from "../src/theme.ts";
import { ConfirmBox } from "../src/tui-confirm.ts";
import type { ConfirmAnswer, ConfirmOptions, JevClient } from "../src/types.ts";
import { failClosedTurn } from "../src/plugins/jev/evaluate.ts";

const savedHome = process.env.AEGIS_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.AEGIS_HOME;
  else process.env.AEGIS_HOME = savedHome;
  setTheme("aegis");
});

const noJev: JevClient = {
  evaluateTurn: async () => failClosedTurn(),
  evaluateTool: async () => {
    throw new Error("Jev must not be called");
  },
};

describe("which 'always allow' rule is offered", () => {
  it("offers a folder rule for edits and the exact command for shell", () => {
    expect(suggestAllowRule("edit", { path: "scripts/ping.ps1" }, undefined)).toBe("edit scripts/*");
    expect(suggestAllowRule("write", { path: "notes.md" }, undefined)).toBe("write notes.md");
    expect(suggestAllowRule("write", { path: ".\\src\\a.ts" }, undefined)).toBe("write src/*");
    expect(suggestAllowRule("shell", { command: "npm test" }, undefined)).toBe("shell npm test");
  });

  it("never offers it when an ask rule matched, for chains, wildcards or protected folders", () => {
    expect(suggestAllowRule("shell", { command: "Remove-Item x" }, { action: "ask", rule: "shell Remove-Item*" })).toBeUndefined();
    expect(suggestAllowRule("shell", { command: "npm test; git push" }, undefined)).toBeUndefined();
    expect(suggestAllowRule("shell", { command: "npm test > out.txt" }, undefined)).toBeUndefined();
    expect(suggestAllowRule("shell", { command: "del *" }, undefined)).toBeUndefined();
    expect(suggestAllowRule("write", { path: ".aegis/settings.json" }, undefined)).toBeUndefined();
    expect(suggestAllowRule("edit", { path: ".git/config" }, undefined)).toBeUndefined();
    expect(suggestAllowRule("read", { path: "a.txt" }, undefined)).toBeUndefined();
  });

  it("saves the rule without dropping the default allow list", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-allow-"));
    saveAllowRule(cwd, "edit scripts/*");
    saveAllowRule(cwd, "edit scripts/*");
    expect(loadSettings(cwd).rules.allow).toEqual([...DEFAULT_SETTINGS.rules.allow, "edit scripts/*"]);
  });
});

describe("answering 'always' at the gate", () => {
  it("saves the rule, runs the call, and the next identical call runs without asking", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-always-"));
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" } }));
    const asked: Array<ConfirmOptions | undefined> = [];
    const answers: ConfirmAnswer[] = ["always"];
    let runs = 0;
    const call = () =>
      runGatedTool({
        name: "edit",
        args: { path: "scripts/ping.ps1", old_string: "a", new_string: "b" },
        cwd,
        jev: noJev,
        config: loadConfig(),
        confirm: async (_q, options) => {
          asked.push(options);
          return answers.shift() ?? false;
        },
        execute: async () => {
          runs += 1;
          return "edited";
        },
      });
    const first = await call();
    expect(asked[0]?.always).toBe("edit scripts/*");
    expect(first.record.approved).toBe(true);
    expect(first.record.savedRule).toBe("edit scripts/*");
    expect(loadSettings(cwd).rules.allow).toContain("edit scripts/*");
    const second = await call();
    expect(asked).toHaveLength(1);
    expect(second.record.rule).toBe("edit scripts/*");
    expect(runs).toBe(2);
  });

  it("offers no 'always' when an ask rule matched", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-noalways-"));
    const asked: Array<ConfirmOptions | undefined> = [];
    await runGatedTool({
      name: "shell",
      args: { command: "Remove-Item -Recurse build" },
      cwd,
      jev: noJev,
      config: loadConfig(),
      confirm: async (_q, options) => {
        asked.push(options);
        return "always";
      },
      execute: async () => "ran",
    });
    expect(asked[0]?.always).toBeUndefined();
    expect(loadSettings(cwd).rules.allow).toEqual(DEFAULT_SETTINGS.rules.allow);
  });
});

describe("the y / a / N prompt", () => {
  it("accepts a only when a rule is offered, and shows the rule", () => {
    const seen: ConfirmAnswer[] = [];
    const withRule = new ConfirmBox("Aegis: edit scripts/ping.ps1", (ok) => seen.push(ok), 24, "edit scripts/*");
    expect(withRule.render(90).join("\n")).toContain("[a] always allow: edit scripts/*");
    withRule.handleInput("a");
    const without = new ConfirmBox("Aegis: shell Remove-Item", (ok) => seen.push(ok), 24);
    expect(without.render(90).join("\n")).not.toContain("always");
    without.handleInput("a");
    without.handleInput("\r");
    expect(seen).toEqual(["always", false]);
  });

  it("REPL answers: a or always → always, only when offered", async () => {
    const confirm = createConfirm({ answers: ["a", "always", "a", "y"] });
    expect(await confirm("q", { always: "edit x/*" })).toBe("always");
    expect(await confirm("q", { always: "edit x/*" })).toBe("always");
    expect(await confirm("q")).toBe(false);
    expect(await confirm("q")).toBe(true);
  });
});

describe("/theme", () => {
  it("switches colours and saves the choice for every folder", async () => {
    process.env.AEGIS_HOME = await mkdtemp(path.join(os.tmpdir(), "aegis-theme-home-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-theme-"));
    const state = await startState(cwd, { local: true, mockJev: true });
    const opts = { mockJev: true, yes: false, local: true };
    expect((await handleLine("/theme", state, opts)).output).toContain("theme  aegis");
    expect(on("accent")).toBe("\x1b[36m");
    expect((await handleLine("/theme light", state, opts)).output).toBe("theme light");
    expect(on("accent")).toBe("\x1b[34m");
    expect(JSON.parse(await readFile(path.join(process.env.AEGIS_HOME, "settings.json"), "utf8")).theme).toBe("light");
    setTheme("aegis");
    expect(loadUserTheme()).toBe("light");
    expect(themeName()).toBe("light");
    expect((await handleLine("/theme neon", state, opts)).output).toContain("usage: /theme");
  });
});
