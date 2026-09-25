import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hardDeny, toAegisCall } from "../src/engines/claude-code.ts";
import { loadSettings, settingsPath } from "../src/rules.ts";
import { handleLine, modelChoices, startState } from "../src/runtime.ts";
import { sessionDir } from "../src/session.ts";
import type { ConfirmAnswer, ConfirmOptions } from "../src/types.ts";

const fixture = path.resolve("tests/fixtures/fake-claude.mjs");
const hookScript = path.resolve("scripts/claude-hook.mjs");

/** A `claude` the engine can start: the fixture itself on Linux/macOS, a .cmd shim on Windows (like npm's). */
async function fakeClaudeBin() {
  if (process.platform !== "win32") {
    chmodSync(fixture, 0o755);
    return fixture;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "fake-claude-"));
  const shim = path.join(dir, "claude.cmd");
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
  return shim;
}

const saved = { ...process.env };
beforeEach(async () => {
  process.env.AEGIS_CLAUDE_BIN = await fakeClaudeBin();
  process.env.AEGIS_HOME = await mkdtemp(path.join(os.tmpdir(), "aegis-claude-home-"));
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

async function project() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-claude-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" } }));
  await writeFile(path.join(cwd, "AGENTS.md"), "Always use PowerShell.");
  const state = await startState(cwd, { local: true, mockJev: true });
  const opts = { mockJev: true, yes: false, local: true };
  return { cwd, state, opts };
}

describe("claude-code engine", () => {
  it("/model claude-code pins it and lists it in the picker", async () => {
    const { state, opts } = await project();
    expect(modelChoices(state).map((row) => row.id)).toContain("claude-code");
    const pinned = await handleLine("/model claude-code", state, opts);
    expect(pinned.output).toContain("your own Claude Code");
    expect(state.model).toBe("claude-code");
  });

  it("says how to install it when claude is missing", async () => {
    process.env.AEGIS_CLAUDE_BIN = path.join(os.tmpdir(), "no-such-claude.exe");
    const { state, opts } = await project();
    expect((await handleLine("/model claude-code", state, opts)).output).toContain("Claude Code is not installed");
    expect(state.modelMode).toBe("auto");
  });

  it("every tool Claude Code wants passes Aegis's lock: 'always' saves the rule, the file is written, the answer comes back", async () => {
    const { cwd, state, opts } = await project();
    await handleLine("/model claude-code", state, opts);
    const asked: Array<ConfirmOptions | undefined> = [];
    const events: string[] = [];
    const confirm = async (_q: string, options?: ConfirmOptions): Promise<ConfirmAnswer> => {
      asked.push(options);
      return "always";
    };
    const result = await handleLine("add a ping script", state, opts, confirm, (event) => events.push(event.type));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.always).toBe("write scripts/*");
    expect(await readFile(path.join(cwd, "scripts", "ping.ps1"), "utf8")).toBe("Test-Connection 127.0.0.1");
    expect(loadSettings(cwd).rules.allow).toContain("write scripts/*");
    expect(result.receipt?.answer).toBe("Wrote scripts/ping.ps1.");
    expect(result.receipt?.model).toBe("claude-code");
    expect(result.receipt?.tools[0]).toMatchObject({ name: "write", approved: true, savedRule: "write scripts/*" });
    expect(result.receipt?.tokens).toEqual({ input: 1000, output: 42 });
    expect(events).toEqual(expect.arrayContaining(["accepted", "reasoning_delta", "tool_start", "awaiting_approval", "tool", "text_delta"]));
    // Your AGENTS.md reaches Claude Code's system prompt; the Claude conversation id is kept for the next turn.
    const dir = sessionDir(cwd, state.session.id);
    expect(await readFile(path.join(dir, "claude-append.md"), "utf8")).toContain("Always use PowerShell.");
    expect((await readFile(path.join(dir, "claude-session"), "utf8")).trim()).toBe("claude-session-1");
    const next = await handleLine("hello again", state, opts, confirm);
    expect(next.receipt?.answer).toContain("resumed=true forked=false");
    // /fork: the fork's first Claude Code turn branches the conversation; later turns resume the branch.
    await handleLine("/fork", state, opts, confirm);
    const branched = await handleLine("in the fork", state, opts, confirm);
    expect(branched.receipt?.answer).toContain("resumed=true forked=true");
    expect((await readFile(path.join(sessionDir(cwd, state.session.id), "claude-session"), "utf8")).trim()).toBe("claude-session-1-fork");
    expect((await handleLine("again in the fork", state, opts, confirm)).receipt?.answer).toContain("forked=false");
    await handleLine(`/resume ${dir.split(/[\\/]/).pop()}`, state, opts, confirm);
    // Second identical write: the saved rule allows it without asking.
    await handleLine("add a ping script", state, opts, confirm);
    expect(asked).toHaveLength(1);
  });

  it("a denied call is blocked inside Claude Code and nothing runs", async () => {
    process.env.AEGIS_ALLOW_SHELL = "1";
    const { cwd, state, opts } = await project();
    await handleLine("/model claude-code", state, opts);
    const questions: string[] = [];
    const result = await handleLine("delete the build folder", state, opts, async (q) => {
      questions.push(q);
      return false;
    });
    expect(questions[0]).toContain("Remove-Item");
    expect(existsSync(path.join(cwd, "DELETED"))).toBe(false);
    expect(result.receipt?.answer).toContain("Blocked: Aegis denied it");
    expect(result.receipt?.tools[0]).toMatchObject({ name: "shell", approved: false });
  });

  it("files Claude Code writes can be rewound", async () => {
    const { cwd, state, opts } = await project();
    await handleLine("/model claude-code", state, opts);
    await handleLine("add a ping script", state, opts, async () => true);
    expect(existsSync(path.join(cwd, "scripts", "ping.ps1"))).toBe(true);
    expect((await handleLine("/rewind", state, opts)).output).toContain("add a ping script");
    const rewound = await handleLine("/rewind 1", state, opts);
    expect(rewound.output).toContain("removed");
    expect(existsSync(path.join(cwd, "scripts", "ping.ps1"))).toBe(false);
    // The chat rewind also starts a fresh Claude conversation.
    expect(existsSync(path.join(sessionDir(cwd, state.session.id), "claude-session"))).toBe(false);
  });

  it("shell stays off unless AEGIS_ALLOW_SHELL=1, even for Claude Code, without asking", async () => {
    delete process.env.AEGIS_ALLOW_SHELL;
    const { cwd, state, opts } = await project();
    await handleLine("/model claude-code", state, opts);
    const result = await handleLine("delete the build folder", state, opts, async () => {
      throw new Error("must not ask");
    });
    expect(result.receipt?.answer).toContain("Shell is disabled in Aegis");
    expect(existsSync(path.join(cwd, "DELETED"))).toBe(false);
  });

  it("files outside the project are refused before any rule (read * does not reach ~/.ssh)", async () => {
    const { state, opts } = await project();
    await handleLine("/model claude-code", state, opts);
    const result = await handleLine("read my secrets", state, opts, async () => {
      throw new Error("must not ask");
    });
    expect(result.receipt?.answer).toContain("outside the project folder");
    expect(result.receipt?.tools[0]).toMatchObject({ name: "read", approved: false });
  });

  it("the settings Aegis gives Claude Code keep the hook on and Claude Code's own mode at 'ask'", async () => {
    const { cwd, state, opts } = await project();
    await handleLine("/model claude-code", state, opts);
    await handleLine("hello", state, opts);
    const settings = JSON.parse(await readFile(path.join(sessionDir(cwd, state.session.id), "claude-settings.json"), "utf8"));
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.permissions.defaultMode).toBe("default");
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(86_400);
  });

  it("Claude Code's own bookkeeping (TodoWrite) is allowed without asking", async () => {
    const { state, opts } = await project();
    await handleLine("/model claude-code", state, opts);
    const result = await handleLine("make a todo list", state, opts, async () => {
      throw new Error("must not ask");
    });
    expect(result.receipt?.answer).toBe("todo allow");
  });

  it("stop ends a running Claude Code turn", async () => {
    const { state, opts } = await project();
    await handleLine("/model claude-code", state, opts);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 500);
    await expect(handleLine("hang forever", state, { ...opts, abortSignal: abort.signal })).rejects.toThrow(/cancelled/);
  });
});

describe("the hook script fails closed", () => {
  it("blocks (exit 2) when there is no Aegis to ask", () => {
    const env = { ...process.env };
    delete env.AEGIS_HOOK_URL;
    const run = spawnSync(process.execPath, [hookScript], { input: "{}", env, encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Aegis blocked");
  });

  it("blocks when Aegis cannot be reached", () => {
    const run = spawnSync(process.execPath, [hookScript], {
      input: "{}",
      env: { ...process.env, AEGIS_HOOK_URL: "http://127.0.0.1:9/", AEGIS_HOOK_TOKEN: "x" },
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
  });
});

describe("hard refusals", () => {
  it("refuses paths outside the folder, and writes to the lock's own files", () => {
    process.env.AEGIS_ALLOW_SHELL = "1";
    const cwd = path.resolve(os.tmpdir(), "proj");
    const hook = path.join(cwd, "scripts", "claude-hook.mjs");
    expect(hardDeny("read", { path: path.join(os.homedir(), ".ssh", "id_rsa") }, cwd, [])).toMatch(/outside/);
    expect(hardDeny("write", { path: "../escape.txt" }, cwd, [])).toMatch(/outside/);
    expect(hardDeny("write", { path: hook }, cwd, [hook])).toMatch(/lock/);
    expect(hardDeny("read", { path: hook }, cwd, [hook])).toBeUndefined();
    expect(hardDeny("edit", { path: "src/a.ts" }, cwd, [hook])).toBeUndefined();
    expect(hardDeny("shell", { command: "git status" }, cwd, [])).toBeUndefined();
    delete process.env.AEGIS_ALLOW_SHELL;
    expect(hardDeny("shell", { command: "git status" }, cwd, [])).toMatch(/Shell is disabled/);
  });
});

describe("Claude Code tools → Aegis rule names", () => {
  it("maps file and shell tools so the same rules apply", () => {
    expect(toAegisCall("Edit", { file_path: "C:/p/a.ts", old_string: "a", new_string: "b" })).toMatchObject({ name: "edit", args: { path: "C:/p/a.ts" } });
    expect(toAegisCall("Bash", { command: "git push" })).toEqual({ name: "shell", args: { command: "git push" } });
    expect(toAegisCall("PowerShell", { command: "Remove-Item x" })).toEqual({ name: "shell", args: { command: "Remove-Item x" } });
    expect(toAegisCall("Glob", { pattern: "**/*.ts" })).toEqual({ name: "glob", args: { pattern: "**/*.ts", path: "." } });
    expect(toAegisCall("WebFetch", { url: "https://x.dev/a" })).toMatchObject({ name: "webfetch", args: { url: "https://x.dev/a" } });
    expect(toAegisCall("WebSearch", { query: "pi harness" })).toEqual({ name: "websearch", args: { query: "pi harness" } });
    expect(toAegisCall("Agent", { prompt: "go" }).name).toBe("agent");
  });
});
