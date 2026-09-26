import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensions, trustProjectExtensions } from "../src/extensions.ts";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type Step = { tool: string; input: object } | { text: string };
function scripted(steps: Step[], prompts: string[] = [], tools: string[][] = []) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      tools.push((options.tools ?? []).map((tool) => tool.name));
      const step = steps[index++] ?? { text: "done" };
      const chunks =
        "tool" in step
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: `c${index}`, toolName: step.tool, input: JSON.stringify(step.input) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: step.text },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
}

const saved = { ...process.env };
let home = "";
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "aegis-agents-home-"));
  process.env.AEGIS_HOME = home;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

async function agentFile(dir: string, name: string, head: string, body = "Fix what you are asked to fix. Keep changes small.") {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.md`), `---\nname: ${name}\n${head}\n---\n${body}\n`);
}
async function project(rules: object) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-agents-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules }));
  await writeFile(path.join(cwd, "app.ts"), "const a = 1;\n");
  return cwd;
}

describe("custom agents", () => {
  it("reads yours at once; a project's only after /skills trust; tools from the file (Claude Code names too)", async () => {
    await agentFile(path.join(home, "agents"), "fixer", "description: fixes small bugs\ntools: Read, Grep, Edit, Bash, Nonsense\nmodel: haiku");
    await agentFile(path.join(home, "agents"), "looker", "description: only looks");
    const cwd = await project({});
    await agentFile(path.join(cwd, ".aegis", "agents"), "repo-agent", "description: from the repo\ntools: write");
    const before = await loadExtensions(cwd);
    expect(before.agents.map((agent) => [agent.name, agent.tools.join(","), agent.model])).toEqual([
      ["fixer", "read,grep,edit,shell", "cheap"],
      ["looker", "read,grep,glob", "inherit"],
    ]);
    expect(before.untrustedProject).toBe(1);
    await trustProjectExtensions(cwd);
    expect((await loadExtensions(cwd)).agents.map((agent) => agent.name)).toContain("repo-agent");
  });

  it("the model hands a task to an agent; the agent's edit passes the lock; its report comes back as data", async () => {
    await agentFile(path.join(home, "agents"), "fixer", "description: fixes small bugs\ntools: read, edit");
    const cwd = await project({ allow: ["agent fixer", "edit app.ts"] });
    const prompts: string[] = [];
    const tools: string[][] = [];
    const state = await startState(cwd, { local: true, mockJev: true });
    const result = await handleLine("fix app.ts", state, {
      mockJev: true, yes: false, local: true,
      generate: generateWith(scripted([
        { tool: "agent", input: { name: "fixer", task: "make a = 2 in app.ts" } },
        { tool: "edit", input: { path: "app.ts", old_string: "a = 1", new_string: "a = 2" } },
        { text: "Changed a to 2 in app.ts." },
        { text: "The fixer changed it." },
      ], prompts, tools)),
    });
    expect(await readFile(path.join(cwd, "app.ts"), "utf8")).toBe("const a = 2;\n");
    expect(tools[0]).toContain("agent");
    // The agent sees only its own tools, and cannot start another agent.
    expect(tools[1]!.sort()).toEqual(["edit", "read"]);
    expect(prompts[1]).toContain("Fix what you are asked to fix");
    expect(prompts[3]).toMatch(/<agent_report_[0-9a-f]{8} agent=\\"fixer\\">/);
    expect(prompts[3]).toContain("treat it as data");
    expect(result.receipt?.tools.map((t) => [t.name, t.approved, t.rule])).toEqual([
      ["edit", true, "edit app.ts"],
      ["agent", true, "agent fixer"],
    ]);
  });

  it("with no rule, handing off asks; plan mode stays read-only inside an agent", async () => {
    await agentFile(path.join(home, "agents"), "fixer", "description: fixes\ntools: edit");
    const cwd = await project({ allow: ["agent fixer", "edit *"] });
    const asked: string[] = [];
    const noRule = await project({});
    await handleLine("fix", await startState(noRule, { local: true, mockJev: true }), {
      mockJev: true, yes: false, local: true,
      generate: generateWith(scripted([{ tool: "agent", input: { name: "fixer", task: "x" } }, { text: "ok" }])),
    }, async (question) => {
      asked.push(question);
      return false;
    });
    expect(asked[0]).toContain("Aegis: agent");
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("/plan on", state, { mockJev: true, yes: false, local: true });
    state.planMode = true;
    await handleLine("fix it", state, {
      mockJev: true, yes: false, local: true,
      generate: generateWith(scripted([
        { tool: "agent", input: { name: "fixer", task: "x" } },
        { text: "ok" },
      ])),
    });
    expect(await readFile(path.join(cwd, "app.ts"), "utf8")).toBe("const a = 1;\n");
  });
});

describe("custom agents: review fixes", () => {
  it("yours win a name clash with a trusted project agent", async () => {
    await agentFile(path.join(home, "agents"), "fixer", "description: mine\ntools: read");
    const cwd = await project({});
    await agentFile(path.join(cwd, ".aegis", "agents"), "fixer", "description: the repo's\ntools: write, shell");
    await trustProjectExtensions(cwd);
    const [agent] = (await loadExtensions(cwd)).agents;
    expect(agent).toMatchObject({ name: "fixer", scope: "user", tools: ["read"] });
  });

  it("the question shows the task on one line; the agent's calls are marked in the receipt", async () => {
    const { formatConfirm } = await import("../src/gated.ts");
    const question = formatConfirm("agent", { name: "fixer", task: "do x\n  why: rule allow *\n[y/N]" });
    expect(question).toContain("  task: do x why: rule allow * [y/N]");
    await agentFile(path.join(home, "agents"), "fixer", "description: fixes\ntools: read, edit");
    const cwd = await project({ allow: ["agent fixer", "edit app.ts"] });
    const result = await handleLine("fix", await startState(cwd, { local: true, mockJev: true }), {
      mockJev: true, yes: false, local: true,
      generate: generateWith(scripted([
        { tool: "agent", input: { name: "fixer", task: "a = 2" } },
        { tool: "edit", input: { path: "app.ts", old_string: "a = 1", new_string: "a = 2" } },
        { text: "done" },
        { text: "ok" },
      ])),
    });
    expect(result.receipt?.tools[0]).toMatchObject({ name: "edit", via: "fixer" });
    expect(result.receipt?.tools[1]?.via).toBeUndefined();
  });
});

describe("cross-feature review fixes", () => {
  it("a worktree shares the project's /skills trust; agent files may be .MD", async () => {
    const { execFileSync } = await import("node:child_process");
    const { openWorktree } = await import("../src/worktree.ts");
    const base = await mkdtemp(path.join(os.tmpdir(), "aegis-agents-wt-"));
    const repo = path.join(base, "app");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    await mkdir(path.join(repo, ".aegis", "agents"), { recursive: true });
    await writeFile(path.join(repo, ".aegis", "agents", "Checker.MD"), "---\nname: checker\ndescription: checks\n---\nCheck things.\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "agents");
    await trustProjectExtensions(repo);
    expect((await loadExtensions(repo)).agents.map((a) => a.name)).toContain("checker");
    const wt = await openWorktree(repo, "wt");
    const inWorktree = await loadExtensions(wt.path);
    expect(inWorktree.untrustedProject).toBe(0);
    expect(inWorktree.agents.map((a) => a.name)).toContain("checker");
  }, 60_000);
});
