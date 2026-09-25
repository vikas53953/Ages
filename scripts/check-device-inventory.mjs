#!/usr/bin/env node
/**
 * Spawned by Aegis runCheck. cwd must be the app workdir (work/<id>).
 * Modes: add | search | ui | restart
 * Does not mark owner acceptance. Exit 0 = that mode passed.
 * Generated Node is cwd-guarded; this is not OS isolation.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEVICE = { id: "probe-host-1", name: "lab-switch" };
const MODE = process.argv[2] ?? "add";
const CWD = process.cwd();
const SERVER = path.join(CWD, "server.mjs");
const STORE = path.join(CWD, "data", "devices.json");
const LISTEN = path.join(CWD, ".listen.json");
const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "app-cwd-guard.cjs");

function inheritEnv() {
  const keys =
    process.platform === "win32"
      ? [
          "PATH",
          "Path",
          "PATHEXT",
          "SYSTEMROOT",
          "SystemRoot",
          "WINDIR",
          "windir",
          "COMSPEC",
          "ComSpec",
          "TEMP",
          "TMP",
          "USERPROFILE",
          "HOMEDRIVE",
          "HOMEPATH",
          "USERNAME",
          "APPDATA",
          "LOCALAPPDATA",
          "ProgramFiles",
          "ProgramW6432",
          "SystemDrive",
          "NUMBER_OF_PROCESSORS",
          "PROCESSOR_ARCHITECTURE",
          "OS",
        ]
      : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "TERM"];
  const out = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  out.AEGIS_APP_ROOT = CWD;
  return out;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function waitForListen(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(LISTEN)) {
      try {
        const row = await readJson(LISTEN);
        if (row?.url && row?.port) return row;
      } catch {
        // still writing
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

async function startServer() {
  if (!existsSync(SERVER)) fail("server.mjs missing", 2);
  try {
    await unlink(LISTEN);
  } catch {
    // none
  }
  const child = spawn(process.execPath, ["--require", GUARD, SERVER], {
    cwd: CWD,
    env: inheritEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  const listen = await waitForListen();
  if (!listen) {
    killTree(child.pid);
    fail(`server did not bind\n${output.slice(0, 2000)}`, 2);
  }
  return { child, listen, output };
}

async function stopServer(child) {
  if (!child.pid) return;
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  killTree(child.pid);
  await exited;
  try {
    await unlink(LISTEN);
  } catch {
    // gone
  }
}

async function request(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, text };
}

function storeHasDevice() {
  if (!existsSync(STORE)) return false;
  try {
    const rows = JSON.parse(readFileSync(STORE, "utf8"));
    return Array.isArray(rows) && rows.some((row) => row?.id === DEVICE.id);
  } catch {
    return false;
  }
}

async function addDevice(url) {
  const posted = await request(`${url}/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(DEVICE),
  });
  if (posted.status !== 201 && posted.status !== 200) {
    fail(`add HTTP ${posted.status} ${posted.text.slice(0, 500)}`);
  }
  if (!storeHasDevice()) fail("JSON store does not contain the added device");
  process.stdout.write(`add ok store=${STORE}\n`);
}

async function searchDevice(url) {
  const found = await request(`${url}/devices?q=${encodeURIComponent(DEVICE.name)}`);
  if (found.status !== 200) fail(`search HTTP ${found.status} ${found.text.slice(0, 500)}`);
  let body;
  try {
    body = JSON.parse(found.text);
  } catch {
    fail("search did not return JSON");
  }
  const rows = Array.isArray(body.devices) ? body.devices : [];
  if (!rows.some((row) => row?.id === DEVICE.id)) fail("search did not return the device");
  process.stdout.write("search ok\n");
}

async function checkUi(url) {
  const page = await request(url);
  if (page.status !== 200) fail(`ui HTTP ${page.status}`);
  if (!/device inventory/i.test(page.text)) fail("ui page missing Device inventory");
  process.stdout.write(`OPEN_URL ${url}\nSTORE ${STORE}\n`);
}

async function main() {
  if (!["add", "search", "ui", "restart"].includes(MODE)) fail(`unknown mode ${MODE}`);
  if (MODE === "add") {
    const { child, listen } = await startServer();
    try {
      await addDevice(listen.url);
    } finally {
      await stopServer(child);
    }
    return;
  }
  if (MODE === "search") {
    const { child, listen } = await startServer();
    try {
      if (!storeHasDevice()) await addDevice(listen.url);
      await searchDevice(listen.url);
    } finally {
      await stopServer(child);
    }
    return;
  }
  if (MODE === "ui") {
    const { child, listen } = await startServer();
    try {
      await checkUi(listen.url);
    } finally {
      await stopServer(child);
    }
    return;
  }
  const first = await startServer();
  try {
    await addDevice(first.listen.url);
  } finally {
    await stopServer(first.child);
  }
  const second = await startServer();
  try {
    await searchDevice(second.listen.url);
  } finally {
    await stopServer(second.child);
  }
  process.stdout.write("restart ok\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(typeof error?.exitCode === "number" ? error.exitCode : 1);
});
