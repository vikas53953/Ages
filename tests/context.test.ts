import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadContext } from "../src/context.ts";
import { buildSystemPrompt } from "../src/system.ts";

describe("loadContext", () => {
  it("loads AGENTS.md into the system prompt", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-ctx-"));
    await writeFile(path.join(cwd, "AGENTS.md"), "Prefer edit over write.", "utf8");
    const context = await loadContext(cwd);
    expect(context).toContain("Prefer edit over write.");
    const prompt = buildSystemPrompt({
      cwd,
      memory: "",
      skills: [],
      context,
    });
    expect(prompt).toContain("Prefer edit over write.");
  });

  it("yours (~/.aegis/AGENTS.md) comes first, then the project's, then AGENTS.local.md", async () => {
    const saved = process.env.AEGIS_HOME;
    const home = await mkdtemp(path.join(os.tmpdir(), "harness-ctx-home-"));
    process.env.AEGIS_HOME = home;
    try {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-ctx-"));
      await writeFile(path.join(home, "AGENTS.md"), "MINE: answer in short lines.");
      await writeFile(path.join(cwd, "AGENTS.md"), "PROJECT: use pnpm.");
      await writeFile(path.join(cwd, "AGENTS.local.md"), "LOCAL: my test DB is on port 5433.");
      const context = await loadContext(cwd);
      expect(context.indexOf("MINE")).toBeLessThan(context.indexOf("PROJECT"));
      expect(context.indexOf("PROJECT")).toBeLessThan(context.indexOf("LOCAL"));
      expect(context).toContain("## Your AGENTS.md (every project)");
    } finally {
      process.env.AEGIS_HOME = saved;
    }
  });
});


describe("/init", () => {
  it("asks the agent to write AGENTS.md from what it finds", async () => {
    const { simulateReadableStream } = await import("ai");
    const { MockLanguageModelV4 } = await import("ai/test");
    const { generateWith } = await import("../src/loop.ts");
    const { handleLine, startState } = await import("../src/runtime.ts");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-init-"));
    const prompts: string[] = [];
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "ok" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ] as never[],
          }),
        };
      },
    });
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("/init", state, { mockJev: true, yes: false, local: true, generate: generateWith(model) });
    expect(prompts[0]).toContain("Create an AGENTS.md for this project");
  });
});
