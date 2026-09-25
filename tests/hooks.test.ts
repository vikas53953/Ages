import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { runGatedTool } from "../src/gated.ts";
import { loadHooks, matcherMatches, parseHooks, type HookConfig } from "../src/hooks.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/rules.ts";

const saved = { ...process.env };
let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "aegis-hooks-"));
  process.env.AEGIS_HOME = path.join(dir, "home");
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

/** A Node hook script (exec form), so the test runs the same on Windows and elsewhere. */
async function script(name: string, body: string) {
  const file = path.join(dir, `${name}.mjs`);
  await writeFile(file, body);
  return { command: process.execPath, args: [file] };
}

function hooks(matcher: string, hook: { command: string; args?: string[]; timeout?: number }): HookConfig {
  return parseHooks({ PreToolUse: [{ matcher, hooks: [{ type: "command", ...hook }] }] });
}

function allowAll(): Settings {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.jev.mode = "off";
  settings.rules.allow = [...settings.rules.allow, "write *"];
  return settings;
}

async function gate(config: HookConfig, answers: Array<boolean | "always"> = []) {
  const asked: Array<{ always?: string; why?: string }> = [];
  let ran = false;
  const run = await runGatedTool({
    name: "write",
    args: { path: "out.txt", contents: "hi" },
    cwd: dir,
    config: loadConfig(),
    settings: allowAll(),
    hooks: config,
    confirm: async (_prompt, info) => {
      asked.push({ always: info?.always, why: info?.why });
      return answers.shift() ?? false;
    },
    execute: async () => {
      ran = true;
      return "wrote";
    },
  });
  return { run, asked, ran };
}

describe("hook matchers (Claude Code's rules)", () => {
  it("exact names with |, * for all, regex otherwise; Aegis and Claude Code names both match", () => {
    expect(matcherMatches("Bash|Write", ["shell", "Bash"])).toBe(true);
    expect(matcherMatches("Bash|Write", ["edit", "Edit"])).toBe(false);
    expect(matcherMatches("*", ["read", "Read"])).toBe(true);
    expect(matcherMatches("", ["read", "Read"])).toBe(true);
    expect(matcherMatches("mcp__github__.*", ["mcp__github__create_issue"])).toBe(true);
    expect(matcherMatches("mcp__github__*", ["mcp__github__create_issue"])).toBe(true);
    expect(matcherMatches("mcp__github__*", ["mcp__gitlab__x"])).toBe(false);
  });

  it("a malformed hooks block is reported, not half-used", () => {
    expect(parseHooks({ PreToolUse: [{ matcher: "(", hooks: [] }] }).error).toContain("bad matcher");
    expect(parseHooks({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "http", url: "x" }] }] }).error).toContain("type");
    expect(parseHooks({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x", timeout: 99999 }] }] }).PreToolUse[0]!.hooks[0]!.timeout).toBe(600);
  });
});

describe("PreToolUse hooks can only tighten", () => {
  it("exit 2 denies even when a rule allows it; stderr is the reason the model sees", async () => {
    const hook = await script("block", 'process.stderr.write("no writes on Fridays"); process.exit(2);');
    const { run, asked, ran } = await gate(hooks("Write", hook));
    expect(ran).toBe(false);
    expect(asked).toHaveLength(0);
    expect(run.record).toMatchObject({ approved: false, source: "hook", action: "deny" });
    expect(run.output).toContain("no writes on Fridays");
  });

  it('JSON "ask" turns an allowed call into a question with no "always" option', async () => {
    const hook = await script(
      "ask",
      'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:"check the file name"}}));',
    );
    const no = await gate(hooks("Write", hook), [false]);
    expect(no.ran).toBe(false);
    expect(no.asked[0]!.always).toBeUndefined();
    expect(no.asked[0]!.why).toContain("check the file name");
    const yes = await gate(hooks("Write", hook), [true]);
    expect(yes.ran).toBe(true);
    expect(yes.run.record.source).toBe("hook");
  });

  it('JSON "allow" does not skip the lock: with no rule you are still asked', async () => {
    const hook = await script("allow", 'process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:"allow"}}));');
    let asked = 0;
    await runGatedTool({
      name: "edit",
      args: { path: "a.txt", old_string: "a", new_string: "b" },
      cwd: dir,
      config: loadConfig(),
      settings: { ...structuredClone(DEFAULT_SETTINGS), jev: { mode: "off" } },
      hooks: hooks("*", hook),
      confirm: async () => {
        asked += 1;
        return false;
      },
      execute: async () => "edited",
    });
    expect(asked).toBe(1);
  });

  it("a hook that crashes or hangs makes Aegis ask instead of letting the call through", async () => {
    const crash = await script("crash", "throw new Error('bug');");
    const crashed = await gate(hooks("*", crash), [false]);
    expect(crashed.asked[0]!.why).toMatch(/exited with 1/);
    expect(crashed.ran).toBe(false);
    const hang = await script("hang", "setTimeout(() => {}, 60000);");
    const hung = await gate(hooks("*", { ...hang, timeout: 1 }), [false]);
    expect(hung.asked[0]!.why).toContain("timed out");
    const missing = await gate(hooks("*", { command: path.join(dir, "no-such-program") , args: [] }), [false]);
    expect(missing.asked).toHaveLength(1);
    const broken = await gate(parseHooks({ PreToolUse: "nope" }), [false]);
    expect(broken.asked[0]!.why).toContain("not valid");
  }, 20_000);

  it("gets Claude Code's JSON on stdin: tool_name Write, absolute file_path, content", async () => {
    const seen = path.join(dir, "seen.json");
    const hook = await script("spy", `import { writeFileSync } from "node:fs"; let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => writeFileSync(${JSON.stringify(seen)}, s));`);
    const { ran } = await gate(hooks("Write", hook));
    expect(ran).toBe(true);
    const payload = JSON.parse(await readFile(seen, "utf8"));
    expect(payload).toMatchObject({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      aegis_tool_name: "write",
      permission_mode: "default",
      tool_input: { path: "out.txt", file_path: path.resolve(dir, "out.txt"), content: "hi" },
    });
  });

  it("a hook that does not match leaves the lock as it was", async () => {
    const hook = await script("block", "process.exit(2);");
    const { ran, asked } = await gate(hooks("Bash", hook));
    expect(ran).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it("shell form works (PowerShell on Windows, sh elsewhere)", async () => {
    const { ran, run } = await gate(parseHooks({ PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "exit 2" }] }] }));
    expect(ran).toBe(false);
    expect(run.record.source).toBe("hook");
  }, 30_000);

  it("reads your hooks from ~/.aegis/settings.json only", async () => {
    await mkdir(process.env.AEGIS_HOME!, { recursive: true });
    await writeFile(path.join(process.env.AEGIS_HOME!, "settings.json"), JSON.stringify({ theme: "light", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] } }));
    expect(loadHooks().PreToolUse[0]!.matcher).toBe("Bash");
    await writeFile(path.join(process.env.AEGIS_HOME!, "settings.json"), "{ nope");
    expect(loadHooks().error).toContain("not valid JSON");
  });
});

describe("hooks: review fixes (never fail open)", () => {
  it("JSON Aegis cannot read, or more output than it reads, makes the call a question", async () => {
    const trailing = await script("trailing", 'process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:"deny"}}) + "\\n[debug] done");');
    expect((await gate(hooks("Write", trailing), [false])).asked[0]!.why).toContain("could not read");
    const huge = await script("huge", 'process.stdout.write(JSON.stringify({reason:"x".repeat(70000), hookSpecificOutput:{permissionDecision:"deny"}}));');
    const big = await gate(hooks("Write", huge), [false]);
    expect(big.ran).toBe(false);
    expect(big.asked[0]!.why).toContain("more than Aegis reads");
  });

  it("a decision at the top level counts too", async () => {
    const top = await script("top", 'process.stdout.write(JSON.stringify({permissionDecision:"deny", permissionDecisionReason:"top-level no"}));');
    const { run, ran } = await gate(hooks("Write", top));
    expect(ran).toBe(false);
    expect(run.output).toContain("top-level no");
  });

  it("a settings file that exists but cannot be read keeps your guards on (asks)", async () => {
    await mkdir(path.join(process.env.AEGIS_HOME!, "settings.json"), { recursive: true }); // a folder: EISDIR
    const config = loadHooks();
    expect(config.error).toContain("could not be read");
    expect((await gate(config, [false])).asked).toHaveLength(1);
  });

  it("a hook's ask on the todo list asks you and never goes to Jev", async () => {
    const ask = await script("ask2", 'process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:"ask"}}));');
    let scored = 0;
    let asked = 0;
    await runGatedTool({
      name: "todo",
      args: { path: "." },
      cwd: dir,
      config: loadConfig(),
      settings: allowAll(),
      hooks: hooks("TodoWrite", ask),
      jev: {
        evaluateTurn: async () => {
          throw new Error("unused");
        },
        evaluateTool: async () => {
          scored += 1;
          throw new Error("must not score");
        },
      },
      confirm: async () => {
        asked += 1;
        return true;
      },
      execute: async () => "ok",
    });
    expect(scored).toBe(0);
    expect(asked).toBe(1);
  });
});
