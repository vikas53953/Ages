import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDeliveryBuild, emptyPlan, savePlan } from "../src/controller.ts";
import {
  agreementFromOwnerText,
  confirmAgreement,
  loadTask,
  proposeNewTask,
} from "../src/delivery.ts";
import { packageRoot } from "../src/env.ts";
import { checkProcessEnv, killProcessTree, runOwnedArgv } from "../src/exec.ts";
import type { GenerateFn } from "../src/loop.ts";

const localOpts = { toolCallId: "t1", messages: [], context: {} } as never;
const SENTINEL = "aegis-review-sentinel-not-a-secret";
const GUARD = path.join(packageRoot(), "scripts", "app-cwd-guard.cjs");

const HANG_UI = `import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const listen = path.join(process.cwd(), ".listen.json");
const server = http.createServer(() => {});
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  fs.writeFileSync(listen, JSON.stringify({ pid: process.pid, port: addr.port, url: "http://127.0.0.1:" + addr.port }));
});
setInterval(() => {}, 1 << 30);
`;

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(file: string, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(file)) {
      try {
        return JSON.parse(await readFile(file, "utf8")) as { pid?: number };
      } catch {
        // still writing
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`missing ${file}`);
}

async function waitDead(pid: number, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pid ${pid} still alive`);
}

describe("execution boundary", () => {
  it("confines a spawned generated app: parent .harness write denied, sentinel not inherited, data still writes", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-appconfine-"));
    const work = path.join(cwd, "work", "device-inventory");
    await mkdir(path.join(cwd, ".harness"), { recursive: true });
    await mkdir(work, { recursive: true });
    await writeFile(
      path.join(work, "server.mjs"),
      `import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
fs.mkdirSync(path.join(root, "data"), { recursive: true });
fs.writeFileSync(path.join(root, "data", "devices.json"), JSON.stringify([{ id: "probe-host-1", name: "lab-switch" }]));
let parentWrite = "not-attempted";
try {
  fs.writeFileSync(path.join(root, "..", "..", ".harness", "review-only.json"), process.env.AEGIS_REVIEW_SENTINEL || "none");
  parentWrite = "wrote";
} catch (error) {
  parentWrite = "denied:" + (error instanceof Error ? error.message : String(error));
}
fs.writeFileSync(path.join(root, "probe.json"), JSON.stringify({
  sentinel: process.env.AEGIS_REVIEW_SENTINEL ?? null,
  parentWrite,
}));
process.exit(0);
`,
      "utf8",
    );
    const previous = process.env.AEGIS_REVIEW_SENTINEL;
    process.env.AEGIS_REVIEW_SENTINEL = SENTINEL;
    try {
      const child = spawn(process.execPath, ["--require", GUARD, path.join(work, "server.mjs")], {
        cwd: work,
        env: checkProcessEnv({ AEGIS_APP_ROOT: work }),
        windowsHide: true,
      });
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 1));
      });
      expect(exitCode).toBe(0);
      const probe = JSON.parse(await readFile(path.join(work, "probe.json"), "utf8")) as {
        sentinel: string | null;
        parentWrite: string;
      };
      expect(probe.sentinel).toBeNull();
      expect(probe.parentWrite).toMatch(/denied/i);
      await expect(readFile(path.join(cwd, ".harness", "review-only.json"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(path.join(work, "data", "devices.json"), "utf8"))).toEqual([
        { id: "probe-host-1", name: "lab-switch" },
      ]);
    } finally {
      if (previous === undefined) delete process.env.AEGIS_REVIEW_SENTINEL;
      else process.env.AEGIS_REVIEW_SENTINEL = previous;
    }
  });

  it("kills the owned process tree on abort, including a hanging grandchild", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-aborttree-"));
    await writeFile(
      path.join(cwd, "hang-check.mjs"),
      `import { spawn } from "node:child_process";
import fs from "node:fs";
fs.writeFileSync("checker-pid.json", JSON.stringify({ pid: process.pid }));
const child = spawn(process.execPath, ["-e", "require('http').createServer(()=>{}).listen(0,'127.0.0.1',function(){require('fs').writeFileSync('child-alive.json', JSON.stringify({pid:process.pid,port:this.address().port}));});setInterval(()=>{},1<<30);"], {
  cwd: process.cwd(),
  stdio: "ignore",
  windowsHide: true,
});
setInterval(() => {}, 1 << 30);
`,
      "utf8",
    );
    const abort = new AbortController();
    const running = runOwnedArgv([process.execPath, path.join(cwd, "hang-check.mjs")], cwd, {
      timeoutMs: 30_000,
      abortSignal: abort.signal,
    });
    const checker = await waitForFile(path.join(cwd, "checker-pid.json"));
    const child = await waitForFile(path.join(cwd, "child-alive.json"));
    expect(checker.pid).toBeTruthy();
    expect(child.pid).toBeTruthy();
    abort.abort();
    const result = await running;
    expect(result.executed).toBe(false);
    expect(result.output).toMatch(/cancelled/);
    await waitDead(child.pid!);
    await waitDead(checker.pid!);
    expect(pidAlive(child.pid!)).toBe(false);
    expect(pidAlive(checker.pid!)).toBe(false);
  }, 20_000);

  it("aborts a hanging UI check, clears the app tree, and keeps readyForReview false", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-abortui-"));
    await proposeNewTask(
      cwd,
      agreementFromOwnerText("device-inventory", "Add a device, search, restart, keep it."),
      "exec-boundary",
    );
    await confirmAgreement(cwd, "owner");
    const taskBefore = await loadTask(cwd);
    expect(taskBefore).toBeTruthy();
    const plan = emptyPlan(taskBefore!);
    for (const node of plan.nodes) {
      if (node.id === "persist" || node.id === "http") {
        node.state = "passed";
        node.attempts = 1;
      }
    }
    await savePlan(cwd, taskBefore!, plan);
    const abort = new AbortController();
    const generate: GenerateFn = async ({ tools }) => {
      await tools.write.execute!({ path: "server.mjs", contents: HANG_UI }, localOpts);
      setTimeout(() => abort.abort(), 800);
      return {
        text: "updated inventory app",
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
        steps: 1,
        finalStepComplete: true,
      };
    };
    await expect(
      runDeliveryBuild({
        cwd,
        sessionId: "exec-boundary",
        mockJev: true,
        generate,
        confirm: async () => true,
        abortSignal: abort.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    const task = await loadTask(cwd);
    expect(task?.readyForReview).toBe(false);
    expect(task?.ownerAccepted).toBe(false);
    const listen = path.join(cwd, "work", "device-inventory", ".listen.json");
    if (existsSync(listen)) {
      try {
        const row = JSON.parse(await readFile(listen, "utf8")) as { pid?: number };
        if (row.pid) {
          if (pidAlive(row.pid)) killProcessTree(row.pid);
          await waitDead(row.pid).catch(() => undefined);
          expect(pidAlive(row.pid)).toBe(false);
        }
      } catch {
        // listen file may be half-written after kill
      }
    }
  }, 20_000);
});
