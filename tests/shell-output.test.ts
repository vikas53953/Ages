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

describe("shell timeouts end what the command started", () => {
  it.runIf(process.platform !== "win32")("a timed-out command's children are killed too (POSIX process group)", async () => {
    const { runPowerShell } = await import("../src/tools/fs.ts");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-shelltree-"));
    const fake = path.join(cwd, "fake-pwsh.mjs");
    await writeFile(
      fake,
      `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
const c = spawn(process.execPath, ["-e", "require('fs').writeFileSync('grandchild.json', JSON.stringify({pid:process.pid}));setInterval(()=>{},1<<30);"], { stdio: "ignore" });
process.stdout.write("started\\n");
setInterval(() => {}, 1 << 30);
`,
    );
    await chmod(fake, 0o755);
    process.env.AEGIS_POWERSHELL = fake;
    const error = (await runPowerShell("anything", cwd, 1500).catch((e: unknown) => e)) as { killed?: boolean; stdout?: string };
    expect(error.killed).toBe(true);
    expect(error.stdout).toContain("started");
    const { pid } = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(cwd, "grandchild.json"), "utf8")) as { pid: number };
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 20_000);
});

describe("shell: batch 6", () => {
  it.runIf(process.platform !== "win32")("ends even when something it started keeps the output pipe open; keeps multi-byte text whole", async () => {
    const { runPowerShell } = await import("../src/tools/fs.ts");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-shellpipe-"));
    const fake = path.join(cwd, "fake-pwsh.mjs");
    await writeFile(
      fake,
      `#!/usr/bin/env node
import { spawn } from "node:child_process";
if (process.argv.at(-1) === "euro") { process.stdout.write("€".repeat(100000), () => process.exit(0)); } else {
const c = spawn(process.execPath, ["-e", "require('fs').writeFileSync('holder.json', JSON.stringify({pid:process.pid}));setInterval(()=>{},1<<30);"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
c.unref();
process.stdout.write("done\\n");
setTimeout(() => process.exit(0), 300);
}
`,
    );
    await chmod(fake, 0o755);
    process.env.AEGIS_POWERSHELL = fake;
    const started = Date.now();
    const result = await runPowerShell("anything", cwd, 1500).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "", stderr: "" }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.stdout).toContain("done");
    try {
      const { pid } = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(cwd, "holder.json"), "utf8")) as { pid: number };
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
    // A timeout that lands after a clean exit (only the helper holds the pipe) is still a success.
    const late = await runPowerShell("anything", cwd, 600);
    expect(late.stdout).toContain("done");
    try {
      const { pid } = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(cwd, "holder.json"), "utf8")) as { pid: number };
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
    const euro = await runPowerShell("euro", cwd, 10_000);
    expect(euro.stdout.length).toBe(100_000);
    expect(euro.stdout).not.toContain("\uFFFD");
  }, 20_000);
});
