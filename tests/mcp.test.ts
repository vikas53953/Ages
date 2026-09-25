import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { closeState, handleLine, startState, type AppState } from "../src/runtime.ts";

const fixture = path.resolve("tests/fixtures/fake-mcp.mjs");
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type Step = { tool: string; input: object } | { text: string };

function scripted(steps: Step[], seen: string[]) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      seen.push(JSON.stringify(options.prompt));
      seen.push(JSON.stringify((options.tools ?? []).map((tool) => tool.name)));
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
const opened: AppState[] = [];
let log = "";
beforeEach(async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "aegis-mcp-home-"));
  process.env.AEGIS_HOME = home;
  log = path.join(home, "calls.log");
  process.env.FAKE_MCP_LOG = log;
});
afterEach(() => {
  while (opened.length) closeState(opened.pop()!);
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const server = { command: process.execPath, args: [fixture] };

async function project(rules: object, where: "user" | "project" = "user") {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-mcp-"));
  await mkdir(path.join(cwd, ".aegis"));
  const mcp = { servers: { fake: server } };
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules, ...(where === "project" ? { mcp } : {}) }));
  if (where === "user") await writeFile(path.join(process.env.AEGIS_HOME!, "settings.json"), JSON.stringify({ mcp }));
  const state = await startState(cwd, { local: true, mockJev: true });
  opened.push(state);
  return { cwd, state };
}
const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean) : []);

describe("MCP tools behind the lock", () => {
  it("/mcp starts your servers and lists their tools as mcp__server__tool", async () => {
    const { state } = await project({});
    const out = (await handleLine("/mcp", state, { mockJev: true, yes: false, local: true })).output;
    expect(out).toMatch(/fake\s+user\s+running, 2 tool\(s\)/);
    expect(out).toContain("mcp__fake__echo");
    expect(out).toContain("mcp__fake__wipe");
  });

  it("an allowed tool runs and its result reaches the model; one with no rule asks, and No means the server never sees it", async () => {
    const { state } = await project({ allow: ["read *", "mcp__fake__echo"] });
    const seen: string[] = [];
    const model = scripted(
      [
        { tool: "mcp__fake__echo", input: { text: "hi" } },
        { tool: "mcp__fake__wipe", input: {} },
        { text: "finished" },
      ],
      seen,
    );
    const questions: string[] = [];
    const result = await handleLine("use the tools", state, { mockJev: true, yes: false, local: true, generate: generateWith(model) }, async (q) => {
      questions.push(q);
      return false;
    });
    expect(seen[1]).toContain("mcp__fake__echo"); // offered to the model
    expect(result.receipt?.tools.map((tool) => [tool.name, tool.approved])).toEqual([
      ["mcp__fake__echo", true],
      ["mcp__fake__wipe", false],
    ]);
    expect(result.receipt?.tools[0]?.rule).toBe("mcp__fake__echo");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("mcp__fake__wipe");
    expect(seen.join("\n")).toContain("echo: hi");
    expect(await calls()).toEqual(["echo"]);
  });

  it("a wildcard rule names every tool of a server: deny mcp__fake__* blocks them all without asking", async () => {
    const { state } = await project({ deny: ["mcp__fake__*"] });
    const model = scripted([{ tool: "mcp__fake__echo", input: { text: "x" } }, { text: "ok" }], []);
    const result = await handleLine("echo", state, { mockJev: true, yes: false, local: true, generate: generateWith(model) }, async () => {
      throw new Error("must not ask");
    });
    expect(result.receipt?.tools[0]).toMatchObject({ approved: false, rule: "mcp__fake__*" });
    expect(await calls()).toEqual([]);
  });

  it("plan mode refuses MCP tools too", async () => {
    const { state } = await project({ allow: ["mcp__fake__echo"] });
    await handleLine("/plan", state, { mockJev: true, yes: false, local: true });
    const model = scripted([{ tool: "mcp__fake__echo", input: { text: "x" } }, { text: "plan" }], []);
    const result = await handleLine("echo", state, { mockJev: true, yes: false, local: true, generate: generateWith(model) });
    expect(result.receipt?.tools[0]).toMatchObject({ approved: false });
    expect(await calls()).toEqual([]);
  });

  it("a project's server does not start until you trust it, and trust is tied to its exact command", async () => {
    const { cwd, state } = await project({}, "project");
    const before = (await handleLine("/mcp", state, { mockJev: true, yes: false, local: true })).output;
    expect(before).toContain("not started: project server, run /mcp trust fake");
    const trusted = (await handleLine("/mcp trust fake", state, { mockJev: true, yes: false, local: true })).output;
    expect(trusted).toContain("Trusted fake");
    expect(trusted).toMatch(/fake\s+running, 2 tool\(s\)/);
    // Changing the command in the project's settings takes the trust away.
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, mcp: { servers: { fake: { ...server, args: [fixture, "--other"] } } } }));
    const changed = (await handleLine("/mcp restart", state, { mockJev: true, yes: false, local: true })).output;
    expect(changed).toContain("not started");
  });

  it("a server that cannot start is reported, not fatal", async () => {
    const { state } = await project({});
    await writeFile(path.join(process.env.AEGIS_HOME!, "settings.json"), JSON.stringify({ mcp: { servers: { broken: { command: path.join(os.tmpdir(), "no-such-mcp-server.exe") } } } }));
    const out = (await handleLine("/mcp restart", state, { mockJev: true, yes: false, local: true })).output;
    expect(out).toMatch(/broken\s+user\s+failed/);
  });

  it("closeState stops the servers", async () => {
    const { state } = await project({});
    await handleLine("/mcp", state, { mockJev: true, yes: false, local: true });
    const connection = state.mcp!.connections[0]!;
    closeState(state);
    expect(connection.closed).toBe(true);
    expect(state.mcp).toBeUndefined();
  });
});
