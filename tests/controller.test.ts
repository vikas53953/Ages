import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleLine, startState } from "../src/runtime.ts";
import { loadTask, writeAgreement, type Agreement } from "../src/plugins/delivery/delivery.ts";
import { writePath } from "../src/tools/write.ts";
import type { GenerateFn } from "../src/loop.ts";

const localOpts = { toolCallId: "t1", messages: [], context: {} } as never;

const legacy = (): Agreement => ({
  id: "controlled-delivery",
  objective: "Keep the existing engine.",
  scope: ["Do not overwrite this record."],
  acceptance: [{ id: "keep", text: "Keep the existing engine." }],
  exclusions: ["Inventing owner acceptance"],
  status: "proposed",
});

const MEMORY_SERVER = `import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const listen = path.join(process.cwd(), ".listen.json");
const rows = [];
const html = "<!doctype html><html><body><h1>Device inventory</h1><form></form></body></html>";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
    return;
  }
  if (req.method === "POST" && url.pathname === "/devices") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const row = JSON.parse(body || "{}");
      rows.push(row);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/devices") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const found = rows.filter((row) => !q || String(row.id).toLowerCase().includes(q) || String(row.name).toLowerCase().includes(q));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ devices: found }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  fs.writeFileSync(listen, JSON.stringify({ pid: process.pid, port: addr.port, url: "http://127.0.0.1:" + addr.port }));
});

function cleanup() {
  try { fs.unlinkSync(listen); } catch {}
  server.close();
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
`;

const PERSIST_SERVER = `import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const store = path.join(process.cwd(), "data", "devices.json");
const listen = path.join(process.cwd(), ".listen.json");
const html = "<!doctype html><html><body><h1>Device inventory</h1><form action=\\"/devices\\"><input name=\\"id\\"><input name=\\"name\\"><button>Add device</button></form></body></html>";

function load() {
  try { return JSON.parse(fs.readFileSync(store, "utf8")); } catch { return []; }
}
function save(rows) {
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, JSON.stringify(rows, null, 2));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
    return;
  }
  if (req.method === "POST" && url.pathname === "/devices") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const row = JSON.parse(body || "{}");
      const rows = load();
      rows.push(row);
      save(rows);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/devices") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const rows = load().filter((row) => !q || String(row.id).toLowerCase().includes(q) || String(row.name).toLowerCase().includes(q));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ devices: rows }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  fs.writeFileSync(listen, JSON.stringify({ pid: process.pid, port: addr.port, url: "http://127.0.0.1:" + addr.port }));
});

function cleanup() {
  try { fs.unlinkSync(listen); } catch {}
  server.close();
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
`;

function builder(writes: string[]): GenerateFn {
  let index = 0;
  return async ({ tools }) => {
    const contents = writes[Math.min(index, writes.length - 1)] ?? PERSIST_SERVER;
    index += 1;
    await tools.write.execute!(
      { path: "server.mjs", contents },
      localOpts,
    );
    return {
      text: "updated inventory app",
      inputTokens: 1,
      outputTokens: 1,
      finishReason: "stop",
      steps: 1,
      finalStepComplete: true,
    };
  };
}

async function confirmInventory(cwd: string) {
  const opts = { mockJev: true, yes: true, local: true } as const;
  const state = await startState(cwd, { local: true, mockJev: true });
  await handleLine("/task new device-inventory", state, opts);
  const proposed = await handleLine(
    [
      "Build a simple device inventory.",
      "Add a device, search for it, restart, and confirm the same device remains.",
    ].join(" "),
    state,
    opts,
  );
  expect(proposed.output).toContain("device-inventory");
  const yes = await handleLine("yes", state, opts);
  expect(yes.output).toContain("confirmed");
  return { state, opts };
}

describe("delivery-loop controller", () => {
  it("repairs a missing store, binds open to the tested hash, and never records owner acceptance", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-ctl-"));
    await writeAgreement(cwd, legacy());
    const { state, opts } = await confirmInventory(cwd);
    const built = await handleLine("/task build", state, { ...opts, generate: builder([MEMORY_SERVER, PERSIST_SERVER]) }, async () => true);
    expect(built.output).toContain("Ready for owner review");
    expect(built.output).toContain("owner accepted  no");
    expect(built.output).toContain("ready for review  yes");
    expect(built.output).toContain("persist");
    expect(built.output).toContain("passed");
    const task = await loadTask(cwd);
    expect(task?.agreement.id).toBe("device-inventory");
    expect(task?.targetDir).toBe(path.resolve(cwd, "work", "device-inventory"));
    expect(task?.implemented).toBe(true);
    expect(task?.readyForReview).toBe(true);
    expect(task?.ownerAccepted).toBe(false);
    expect(task?.checks.some((row) => row.criterionId === "add" && row.executed && row.status === "passed")).toBe(true);
    const opened = await handleLine("/task open", state, opts);
    expect(opened.output).toContain("http://127.0.0.1:");
    expect(opened.output).toContain("server.mjs");
    expect(opened.output).toContain("This is not owner acceptance");
    await writeFile(path.join(cwd, "work", "device-inventory", "server.mjs"), `${PERSIST_SERVER}\n// edited\n`, "utf8");
    const stale = await handleLine("/task open", state, opts);
    expect(stale.output).toMatch(/stale|does not match tested/i);
    const original = JSON.parse(
      await readFile(path.join(cwd, ".harness", "task", "agreement.json"), "utf8"),
    ) as { id: string; status: string };
    expect(original.id).toBe("controlled-delivery");
    expect(original.status).toBe("proposed");
    await expect(writePath(".harness/tasks/device-inventory/meta.json", '{"ownerAccepted":true}', cwd)).rejects.toThrow(
      /Delivery records/,
    );
    const afterCheat = await loadTask(cwd);
    expect(afterCheat?.ownerAccepted).toBe(false);
  }, 60_000);

  it("does not let yes confirm a pending inventory proposal after /new", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-ctl-yes-"));
    await writeAgreement(cwd, legacy());
    const opts = { mockJev: true, yes: true, local: true } as const;
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("/task new device-inventory", state, opts);
    await handleLine("Add a device, search, restart, keep it.", state, opts);
    await handleLine("/new", state, opts);
    const afterNew = await handleLine("yes", state, opts);
    expect(afterNew.output).toContain("Plain yes did not confirm");
    expect((await loadTask(cwd))?.agreement.id).toBe("controlled-delivery");
    expect((await loadTask(cwd))?.agreement.status).toBe("proposed");
  });

  it("stops after the repair budget and does not convert that block into a pass", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-ctl-block-"));
    await writeAgreement(cwd, legacy());
    const { state, opts } = await confirmInventory(cwd);
    const blocked = await handleLine(
      "/task build",
      state,
      { ...opts, generate: builder([MEMORY_SERVER]) },
      async () => true,
    );
    expect(blocked.output).toContain("Blocked on 'persist'");
    expect(blocked.output).not.toContain("Ready for owner review");
    const task = await loadTask(cwd);
    expect(task?.readyForReview).toBe(false);
    expect(task?.ownerAccepted).toBe(false);
    expect(task?.implemented).toBe(false);
  }, 60_000);
});
