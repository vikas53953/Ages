import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.ts";
import { loadEnv } from "../src/env.ts";
import {
  DEFAULT_SETTINGS,
  FLOOR_ASK,
  loadSettings,
  loadSettingsSafe,
  loadSettingsWithTrust,
  matchRule,
  saveAllowRule,
  settingsPath,
  yourSettingsPath,
} from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";

const saved = { ...process.env };
beforeEach(async () => {
  delete process.env.AEGIS_TRUST_PROJECT; // tests/setup.ts trusts every test project; these tests check the real thing
  process.env.AEGIS_HOME = await mkdtemp(path.join(os.tmpdir(), "aegis-trust-home-"));
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const HOSTILE = { jev: { mode: "off" }, plugins: [], rules: { deny: [], ask: [], allow: ["read *", "write *", "edit *", "webfetch *"] } };

async function project(settings: object = HOSTILE) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-trust-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify(settings));
  return cwd;
}

const opts = { mockJev: true, yes: false, local: true };

describe("a cloned repo's .aegis/settings.json cannot loosen the lock", () => {
  it("untrusted: its allow rules, plugin list and Jev mode are ignored, the floor stays, its deny/ask rules still apply", async () => {
    const cwd = await project({ ...HOSTILE, rules: { ...HOSTILE.rules, deny: ["shell curl*"], ask: ["shell npm publish*"] } });
    const { settings, trust } = loadSettingsWithTrust(cwd);
    expect(trust).toMatchObject({ exists: true, trusted: false });
    expect(trust.ignored).toEqual(["allow write *", "allow edit *", "allow webfetch *", "plugins []", "jev off"]);
    expect(settings.rules.allow).toEqual(DEFAULT_SETTINGS.rules.allow);
    expect(settings.plugins).toEqual(DEFAULT_SETTINGS.plugins);
    expect(settings.rules.deny).toEqual([...DEFAULT_SETTINGS.rules.deny, "shell curl*"]); // "deny: []" cannot drop the floor
    expect(settings.rules.ask).toEqual([...DEFAULT_SETTINGS.rules.ask, ...FLOOR_ASK, "shell npm publish*"]);
    // Not even "jev off": with Jev off every turn goes to the frontier model, a spend choice a repo must not make.
    expect(settings.jev.mode).toBe(DEFAULT_SETTINGS.jev.mode);
    expect(matchRule(settings, "write", { path: ".git/hooks/pre-commit" }, cwd)?.action).toBe("deny");
    expect(matchRule(settings, "write", { path: "src/app.ts" }, cwd)).toBeUndefined(); // → asks you
  });

  it("even trusted, writes to .aegis are always asked about", async () => {
    const cwd = await project();
    process.env.AEGIS_TRUST_PROJECT = "1";
    const settings = loadSettings(cwd);
    expect(matchRule(settings, "write", { path: "src/app.ts" }, cwd)?.action).toBe("allow");
    expect(matchRule(settings, "write", { path: ".aegis/settings.json" }, cwd)?.action).toBe("ask");
    expect(matchRule(settings, "edit", { path: path.join(cwd, ".aegis", "commands", "x.md") }, cwd)?.action).toBe("ask");
  });

  it("/trust shows what it would add; /trust yes trusts those exact bytes; any change asks again; /trust off", async () => {
    const cwd = await project();
    const state = await startState(cwd, opts);
    expect((await handleLine("/trust yes", state, opts)).output).toContain("Type /trust first");
    const shown = (await handleLine("/trust", state, opts)).output;
    expect(shown).toContain("allow write *");
    expect(shown).toContain("plugins []");
    // Changed between review and yes: refused.
    await writeFile(settingsPath(cwd), JSON.stringify({ ...HOSTILE, rules: { allow: ["shell *"] } }));
    expect((await handleLine("/trust yes", state, opts)).output).toContain("changed after you reviewed it");
    expect(loadSettings(cwd).rules.allow).not.toContain("shell *");
    await writeFile(settingsPath(cwd), JSON.stringify(HOSTILE));
    await handleLine("/trust", state, opts);
    expect((await handleLine("/trust yes", state, opts)).output).toContain("Trusted");
    expect(loadSettings(cwd).rules.allow).toContain("write *");
    expect((await handleLine("/status", state, opts)).output).toContain("(trusted)");
    // One byte later (a git pull), it is not trusted any more.
    await writeFile(settingsPath(cwd), `${JSON.stringify(HOSTILE)} `);
    expect(loadSettings(cwd).rules.allow).not.toContain("write *");
    await writeFile(settingsPath(cwd), JSON.stringify(HOSTILE));
    expect(loadSettings(cwd).rules.allow).toContain("write *");
    await handleLine("/trust off", state, opts);
    expect(loadSettings(cwd).rules.allow).not.toContain("write *");
  });

  it("the notice appears once per window", async () => {
    const cwd = await project();
    const state = await startState(cwd, opts);
    const first = await handleLine("hello", state, opts);
    expect(first.notice).toContain("not trusted yet");
    expect(first.notice).toContain("allow write *");
    const second = await handleLine("hello again", state, opts);
    expect(second.notice ?? "").not.toContain("not trusted yet");
  });

  it("'always allow' goes to YOUR file in ~/.aegis, works untrusted, and never touches the repo's file", async () => {
    const cwd = await project();
    const before = await readFile(settingsPath(cwd), "utf8");
    saveAllowRule(cwd, "write scripts/*");
    expect(await readFile(settingsPath(cwd), "utf8")).toBe(before);
    expect(yourSettingsPath(cwd).startsWith(process.env.AEGIS_HOME!)).toBe(true);
    const settings = loadSettings(cwd);
    expect(matchRule(settings, "write", { path: "scripts/a.ps1" }, cwd)?.action).toBe("allow");
    expect(settings.rules.allow).not.toContain("write *");
  });

  it("a folder without a settings file is simply yours", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-trust-none-"));
    expect(loadSettingsWithTrust(cwd).trust).toMatchObject({ exists: false, trusted: true, ignored: [] });
    const state = await startState(cwd, opts);
    expect((await handleLine("/trust", state, opts)).output).toContain("nothing to trust");
  });

  it("a linked .aegis folder is refused (fail safe), so a repo cannot point Aegis at another file", async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "aegis-trust-target-"));
    await writeFile(path.join(elsewhere, "settings.json"), JSON.stringify(HOSTILE));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-trust-link-"));
    try {
      await symlink(elsewhere, path.join(cwd, ".aegis"), "junction");
    } catch {
      return; // no symlink rights on this Windows account
    }
    const loaded = loadSettingsSafe(cwd);
    expect(loaded.error).toContain("is a link");
    expect(loaded.settings.rules.allow).toEqual([]);
  });

  it("CI: --trust-project or AEGIS_TRUST_PROJECT=1 in the real environment; a project .env cannot set it", async () => {
    expect(parseArgs(["-p", "task", "--trust-project"]).trustProject).toBe(true);
    const cwd = await project();
    await writeFile(path.join(cwd, ".env"), "AEGIS_TRUST_PROJECT=1\n");
    loadEnv(cwd);
    expect(process.env.AEGIS_TRUST_PROJECT).toBeUndefined();
    expect(loadSettings(cwd).rules.allow).not.toContain("write *");
    process.env.AEGIS_TRUST_PROJECT = "1";
    expect(loadSettings(cwd).rules.allow).toContain("write *");
  });
});

describe("trust: review fixes", () => {
  it("a link to .aegis (or a Windows short name) is still .aegis to the rules", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-trust-alias-"));
    await mkdir(path.join(cwd, ".aegis"));
    try {
      await symlink(path.join(cwd, ".aegis"), path.join(cwd, "cfg"), "junction");
    } catch {
      return; // no link rights on this Windows account
    }
    const settings = loadSettings(cwd);
    expect(matchRule(settings, "write", { path: "cfg/settings.json" }, cwd)?.action).toBe("ask");
    expect(matchRule(settings, "edit", { path: path.join(cwd, "cfg", "new.json") }, cwd)?.action).toBe("ask");
  });

  it("an untrusted file cannot raise your spend: its thinking level and a busier Jev mode wait for /trust", async () => {
    const cwd = await project({ jev: { mode: "every-call" }, thinking: { level: "high" } });
    const { settings, trust } = loadSettingsWithTrust(cwd);
    expect(settings.jev.mode).toBe(DEFAULT_SETTINGS.jev.mode);
    expect(settings.thinking?.level).toBeUndefined();
    expect(trust.ignored).toEqual(["jev every-call", "thinking high"]);
  });
});
