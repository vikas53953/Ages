import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { runGatedTool } from "../src/gated.ts";
import { failClosedTool, failClosedTurn } from "../src/plugins/jev/evaluate.ts";
import { mockJev } from "../src/plugins/jev/mock.ts";
import { runLoop } from "../src/loop.ts";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadSettingsSafe,
  matchRule,
  suggestAllowRule,
  parseJevMode,
  saveJevMode,
  settingsPath,
  type Settings,
  FLOOR_ASK,
  yourSettingsPath,
} from "../src/rules.ts";
import type { JevClient, JsonObject, ToolDecision } from "../src/types.ts";

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), "aegis-rules-"));
}

function withMode(mode: Settings["jev"]["mode"], rules: Partial<Settings["rules"]> = {}): Settings {
  return { jev: { mode }, rules: { ...DEFAULT_SETTINGS.rules, ...rules }, plugins: DEFAULT_SETTINGS.plugins };
}

/** A Jev that counts its calls and returns a fixed score. */
function countingJev(score: ToolDecision) {
  const calls: string[] = [];
  const jev: JevClient = {
    evaluateTurn: async () => failClosedTurn(),
    evaluateTool: async (state) => {
      calls.push(state.name);
      return score;
    },
  };
  return { jev, calls };
}

const irreversible: ToolDecision = {
  class: "irreversible",
  dataLoss: 0.9,
  confidence: 0.9,
  probabilities: { class: { read_only: 0, reversible: 0, irreversible: 1 } },
  source: "mock",
};

const safeWrite: ToolDecision = {
  class: "reversible",
  dataLoss: 0.1,
  confidence: 0.95,
  probabilities: { class: { read_only: 0, reversible: 1, irreversible: 0 } },
  source: "mock",
};

async function gate(input: {
  name: string;
  args: JsonObject;
  settings?: Settings;
  jev: JevClient;
  answer?: boolean;
  cwd?: string;
}) {
  const cwd = input.cwd ?? (await tmp());
  const asked: string[] = [];
  let ran = false;
  const result = await runGatedTool({
    name: input.name,
    args: input.args,
    cwd,
    jev: input.jev,
    config: loadConfig(),
    settings: input.settings,
    confirm: async (question) => {
      asked.push(question);
      return input.answer ?? false;
    },
    execute: async () => {
      ran = true;
      return "ran";
    },
  });
  return { result, asked, ran };
}

describe("rule matching", () => {
  const s = DEFAULT_SETTINGS;

  it("allows read and grep by default", () => {
    expect(matchRule(s, "read", { path: "src/loop.ts" })?.action).toBe("allow");
    expect(matchRule(s, "grep", { pattern: "x", path: "." })?.action).toBe("allow");
  });

  it("leaves write, edit and ordinary shell unmatched (grey zone)", () => {
    expect(matchRule(s, "write", { path: "notes.md" })).toBeUndefined();
    expect(matchRule(s, "edit", { path: "src/a.ts" })).toBeUndefined();
    expect(matchRule(s, "shell", { command: "npm install" })).toBeUndefined();
  });

  it("asks before Remove-Item and git push, case-insensitive", () => {
    expect(matchRule(s, "shell", { command: "Remove-Item -Recurse build" })).toEqual({
      action: "ask",
      rule: "shell Remove-Item*",
    });
    expect(matchRule(s, "shell", { command: "remove-item x" })?.action).toBe("ask");
    expect(matchRule(s, "shell", { command: "git push origin main" })?.action).toBe("ask");
  });

  it("catches a dangerous command hidden later in a chain", () => {
    expect(matchRule(s, "shell", { command: "git status; Remove-Item -Recurse ." })?.action).toBe("ask");
    expect(matchRule(s, "shell", { command: "echo hi && git push -f" })?.action).toBe("ask");
  });

  it("never lets an allow rule cover a chained or redirected command", () => {
    const allowStatus = withMode("off", { allow: ["shell git status"] });
    expect(matchRule(allowStatus, "shell", { command: "git status" })?.action).toBe("allow");
    expect(matchRule(allowStatus, "shell", { command: "git status; npm publish" })).toBeUndefined();
    expect(matchRule(allowStatus, "shell", { command: "git status > out.txt" })).toBeUndefined();
    const allowAnyGit = withMode("off", { allow: ["shell git *"] });
    expect(matchRule(allowAnyGit, "shell", { command: "git log | Out-File x" })).toBeUndefined();
  });

  it("denies writes into .git and .harness, with Windows or ./ paths", () => {
    expect(matchRule(s, "write", { path: ".git/config" })?.action).toBe("deny");
    expect(matchRule(s, "edit", { path: ".\\.harness\\receipts\\x.jsonl" })?.action).toBe("deny");
    expect(matchRule(s, "write", { path: "./.GIT/HEAD" })?.action).toBe("deny");
  });

  it("deny beats ask beats allow", () => {
    const clash = withMode("off", {
      deny: ["write secret*"],
      ask: ["write secret*"],
      allow: ["write *"],
    });
    expect(matchRule(clash, "write", { path: "secret.txt" })?.action).toBe("deny");
    expect(matchRule(clash, "write", { path: "notes.txt" })?.action).toBe("allow");
  });
});

describe("settings file", () => {
  it("uses defaults when .aegis/settings.json is missing", async () => {
    const cwd = await tmp();
    const settings = loadSettings(cwd);
    expect(settings.rules.allow).toEqual(DEFAULT_SETTINGS.rules.allow);
    expect(settings.rules.deny).toEqual(DEFAULT_SETTINGS.rules.deny);
    expect(settings.rules.ask).toEqual([...DEFAULT_SETTINGS.rules.ask, ...FLOOR_ASK]);
    expect(settings.jev).toEqual(DEFAULT_SETTINGS.jev);
    expect(settings.plugins).toEqual(DEFAULT_SETTINGS.plugins);
  });

  it("lists add up: a trusted file's allow rules join the defaults; deny and ask only add to the floor", async () => {
    const cwd = await tmp();
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { allow: ["read *", "shell npm test"] } }));
    const settings = loadSettings(cwd);
    expect(settings.jev.mode).toBe("off");
    expect(settings.rules.allow).toEqual([...DEFAULT_SETTINGS.rules.allow, "shell npm test"]);
    expect(settings.rules.ask).toEqual([...DEFAULT_SETTINGS.rules.ask, ...FLOOR_ASK]);
  });

  it("fails safe on a broken file: Jev off, no allow rules, error reported", async () => {
    const cwd = await tmp();
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), "{ not json");
    const loaded = loadSettingsSafe(cwd);
    expect(loaded.error).toBeTruthy();
    expect(loaded.settings.jev.mode).toBe("off");
    expect(loaded.settings.rules.allow).toEqual([]);
    expect(loaded.settings.rules.deny).toEqual(DEFAULT_SETTINGS.rules.deny);
  });

  it("rejects a plugins value that is not a list of names", async () => {
    const cwd = await tmp();
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ plugins: "jev" }));
    expect(() => loadSettings(cwd)).toThrow(/plugins must be a list/);
  });

  it("rejects an unknown Jev mode", async () => {
    const cwd = await tmp();
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "sometimes" } }));
    expect(() => loadSettings(cwd)).toThrow(/jev.mode/);
  });

  it("/jev saves only the mode and keeps the owner's rules", async () => {
    const cwd = await tmp();
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ rules: { allow: ["read *", "shell git status"] } }));
    saveJevMode(cwd, "every-call");
    // The project's file is left alone; your choice lands in ~/.aegis/projects/<id>/settings.json.
    expect(JSON.parse(await readFile(settingsPath(cwd), "utf8"))).toEqual({ rules: { allow: ["read *", "shell git status"] } });
    expect(JSON.parse(await readFile(yourSettingsPath(cwd), "utf8")).jev.mode).toBe("every-call");
    expect(loadSettings(cwd).jev.mode).toBe("every-call");
    expect(loadSettings(cwd).rules.allow).toEqual([...DEFAULT_SETTINGS.rules.allow, "shell git status"]);
    expect(parseJevMode("second")).toBe("second-opinion");
    expect(parseJevMode("every")).toBe("every-call");
    expect(parseJevMode("maybe")).toBeUndefined();
  });
});

describe("gate order: path guard → rules → Jev → you", () => {
  it("runs a read with no Jev key and never calls Jev", async () => {
    const { jev, calls } = countingJev(failClosedTool());
    const { result, asked, ran } = await gate({ name: "read", args: { path: "." }, jev });
    expect(ran).toBe(true);
    expect(asked).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(result.record.source).toBe("rule");
    expect(result.record.rule).toBe("read *");
  });

  it("second-opinion: Jev scores a grey-zone write and may auto-run it", async () => {
    const { jev, calls } = countingJev(safeWrite);
    const { result, asked, ran } = await gate({ name: "write", args: { path: "a.txt", contents: "x" }, jev });
    expect(calls).toEqual(["write"]);
    expect(asked).toHaveLength(0);
    expect(ran).toBe(true);
    expect(result.record.source).toBe("mock");
  });

  it("second-opinion: a matching ask rule decides and Jev is not called", async () => {
    const { jev, calls } = countingJev(safeWrite);
    const { result, asked, ran } = await gate({
      name: "shell",
      args: { command: "Remove-Item -Recurse build" },
      jev,
    });
    expect(calls).toHaveLength(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('rule "shell Remove-Item*" → ask');
    expect(ran).toBe(false);
    expect(result.record.action).toBe("confirm");
    expect(result.record.source).toBe("rule");
  });

  it("off: a grey-zone write asks you and Jev is not called", async () => {
    const { jev, calls } = countingJev(safeWrite);
    const { result, asked, ran } = await gate({
      name: "write",
      args: { path: "a.txt", contents: "x" },
      jev,
      settings: withMode("off"),
      answer: true,
    });
    expect(calls).toHaveLength(0);
    expect(asked[0]).toContain("Jev off");
    expect(ran).toBe(true);
    expect(result.record.source).toBe("default");
  });

  it("a deny rule blocks before Jev and before you, in every mode", async () => {
    for (const mode of ["off", "second-opinion", "every-call"] as const) {
      const { jev, calls } = countingJev(safeWrite);
      const { result, asked, ran } = await gate({
        name: "write",
        args: { path: ".git/config", contents: "x" },
        jev,
        settings: withMode(mode),
        answer: true,
      });
      expect(calls).toHaveLength(0);
      expect(asked).toHaveLength(0);
      expect(ran).toBe(false);
      expect(result.record.action).toBe("deny");
      expect(result.record.deniedReason).toBe("rule: write .git/*");
    }
  });

  it("every-call: Jev tightens an allow rule on a mutation to ask", async () => {
    const { jev, calls } = countingJev(irreversible);
    const { result, asked, ran } = await gate({
      name: "shell",
      args: { command: "git status" },
      jev,
      settings: withMode("every-call", { allow: ["shell git status"] }),
    });
    expect(calls).toEqual(["shell"]);
    expect(asked).toHaveLength(1);
    expect(ran).toBe(false);
    expect(result.record.action).toBe("confirm");
    expect(result.record.source).toBe("mock");
  });

  it("every-call: Jev cannot loosen an ask rule", async () => {
    const { jev, calls } = countingJev(safeWrite);
    const { result, asked } = await gate({
      name: "shell",
      args: { command: "git push" },
      jev,
      settings: withMode("every-call"),
    });
    expect(calls).toEqual(["shell"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("via mock");
    expect(result.record.action).toBe("confirm");
    expect(result.record.source).toBe("rule");
  });

  it("every-call: reads stay rule-only, no Jev call", async () => {
    const { jev, calls } = countingJev(irreversible);
    const { ran } = await gate({ name: "read", args: { path: "." }, jev, settings: withMode("every-call") });
    expect(calls).toHaveLength(0);
    expect(ran).toBe(true);
  });

  it("reads settings from the folder when none are passed in", async () => {
    const cwd = await tmp();
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" } }));
    const { jev, calls } = countingJev(safeWrite);
    const { asked } = await gate({ name: "write", args: { path: "a.txt", contents: "x" }, jev, cwd });
    expect(calls).toHaveLength(0);
    expect(asked).toHaveLength(1);
  });
});

describe("turn routing with Jev off", () => {
  it("skips Jev turn scoring and uses the frontier model", async () => {
    const cwd = await tmp();
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" } }));
    let turnCalls = 0;
    const jev = mockJev();
    const receipt = await runLoop({
      prompt: "what files are here?",
      cwd,
      jev: { ...jev, evaluateTurn: async (state) => (turnCalls++, jev.evaluateTurn(state)) },
      config: loadConfig(),
      confirm: async () => false,
      sessionId: "jev-off",
      provider: "local",
      generate: async () => ({ text: "done", inputTokens: 0, outputTokens: 0 }),
    });
    expect(turnCalls).toBe(0);
    expect(receipt.turn.source).toBe("off");
    expect(receipt.routeReason).toBe("jev off");
    expect(receipt.model).toBe(loadConfig().frontierModel);
  });

  it("still honours a pinned model when Jev is off", async () => {
    const cwd = await tmp();
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" } }));
    const receipt = await runLoop({
      prompt: "hi",
      cwd,
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => false,
      sessionId: "jev-off-pin",
      provider: "local",
      model: "glm-5.3",
      generate: async () => ({ text: "done", inputTokens: 0, outputTokens: 0 }),
    });
    expect(receipt.model).toBe("glm-5.3");
    expect(receipt.routeReason).toBe("selected");
  });
});

describe("webfetch rules match the host", () => {
  const withRules = (rules: object) => ({ ...DEFAULT_SETTINGS, rules: { ...DEFAULT_SETTINGS.rules, ...rules } });
  it("exact host, subdomain wildcard, and * never crossing a dot", () => {
    const s = withRules({ allow: ["webfetch docs.microsoft.com", "webfetch *.github.com"], deny: ["webfetch evil.*"], ask: [] });
    const fetch = (url: string) => matchRule(s, "webfetch", { url })?.action;
    expect(fetch("https://docs.microsoft.com/en-us/powershell")).toBe("allow");
    expect(fetch("https://DOCS.microsoft.com./x")).toBe("allow");
    expect(fetch("https://learn.microsoft.com/")).toBeUndefined();
    expect(fetch("https://api.github.com/repos")).toBe("allow");
    expect(fetch("https://a.b.github.com/")).toBe("allow");
    expect(fetch("https://github.com/")).toBeUndefined(); // *.x.com is subdomains only
    expect(fetch("https://evil.com/")).toBe("deny");
    expect(fetch("https://evil.example.com/")).toBeUndefined(); // * does not cross a dot
    expect(fetch("file:///etc/passwd")).toBeUndefined();
  });
  it("'always allow' offers the exact host", () => {
    expect(suggestAllowRule("webfetch", { url: "https://docs.microsoft.com/x" }, undefined)).toBe("webfetch docs.microsoft.com");
    expect(suggestAllowRule("webfetch", { url: "not a url" }, undefined)).toBeUndefined();
  });
});
