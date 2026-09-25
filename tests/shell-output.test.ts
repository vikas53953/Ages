import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

describe("agent shell output", () => {
  it("a failing command still returns what it printed, with its exit code", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-shellout-"));
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { allow: ["shell Write-Output*"] } }));
    process.env.AEGIS_ALLOW_SHELL = "1";
    if (process.platform !== "win32") {
      // No PowerShell here: a stand-in that prints and fails the same way.
      const fake = path.join(cwd, "fake-pwsh.mjs");
      await writeFile(fake, "#!/usr/bin/env node\nprocess.stdout.write('partial\\n');\nprocess.exit(3);\n");
      await chmod(fake, 0o755);
      process.env.AEGIS_POWERSHELL = fake;
    }
    const prompts: string[] = [];
    let index = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        index += 1;
        const chunks =
          index === 1
            ? [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "s", toolName: "shell", input: JSON.stringify({ command: "Write-Output partial; exit 3" }) },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "ok" },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
              ];
        return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
      },
    });
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("run it", state, { mockJev: true, yes: true, local: true, generate: generateWith(model) }, async () => true);
    expect(prompts[1]).toContain("partial");
    expect(prompts[1]).toContain("[exit code 3]");
  }, 60_000);
});
