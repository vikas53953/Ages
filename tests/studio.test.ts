import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { loadSettings, settingsPath } from "../src/rules.ts";
import { displayMessages, startStudio, type StudioEvent } from "../src/studio.ts";

const usage = {
  inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 60, text: 60, reasoning: undefined },
};

/** A model that writes scripts/ping.ps1, then answers. */
function writerModel() {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      const chunks =
        call === 1
          ? [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "w1",
                toolName: "write",
                input: JSON.stringify({ path: "scripts/ping.ps1", contents: "Test-Connection 127.0.0.1" }),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "Wrote **scripts/ping.ps1**." },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
}

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function studio(generate = generateWith(writerModel())) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-studio-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" } }));
  const server = await startStudio({ cwd, opts: { mockJev: true, yes: false, local: true, generate } });
  open.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const api = async (p: string, body?: unknown) => {
    const res = await fetch(base + p, {
      method: body ? "POST" : "GET",
      headers: { "x-aegis-token": server.token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> & unknown[] };
  };
  return { cwd, server, base, api };
}

/** Read the event stream until `until` returns true. */
async function events(base: string, token: string, until: (e: StudioEvent) => boolean, onEach?: (e: StudioEvent) => void) {
  const res = await fetch(`${base}/api/events?t=${token}`);
  const reader = res.body!.getReader();
  const seen: StudioEvent[] = [];
  let buffer = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (!frame.startsWith("data: ")) continue;
      const event = JSON.parse(frame.slice(6)) as StudioEvent;
      seen.push(event);
      onEach?.(event);
      if (until(event)) {
        await reader.cancel();
        return seen;
      }
    }
  }
  await reader.cancel();
  throw new Error(`stream ended without the expected event: ${JSON.stringify(seen.map((e) => e.kind))}`);
}

describe("Aegis Studio server", () => {
  it("serves the page with a strict CSP and refuses API calls without the key", async () => {
    const { base, server } = await studio();
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await page.text()).toContain("Aegis Studio");
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/state?t=wrong`)).status).toBe(401);
    expect((await fetch(`${base}/api/state`, { headers: { "x-aegis-token": server.token } })).status).toBe(200);
  });

  it("refuses a request whose Host header is not 127.0.0.1 or localhost (DNS rebinding)", async () => {
    const { server } = await studio();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path: "/api/state", headers: { host: `evil.example:${server.port}`, "x-aegis-token": server.token } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("runs a turn: streams events, shows an approval card, 'always' saves the rule, and the answer arrives", async () => {
    const { base, server, api, cwd } = await studio();
    const kinds: string[] = [];
    const collected = events(base, server.token, (e) => e.kind === "done", (e) => {
      kinds.push(e.kind === "event" ? e.event.type : e.kind);
      if (e.kind === "approval") {
        expect(e.options?.always).toBe("write scripts/*");
        expect(e.question).toContain("scripts/ping.ps1");
        void api("/api/approve", { id: e.id, answer: "always" });
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = await api("/api/prompt", { text: "add a ping script" });
    expect(started.status).toBe(202);
    const seen = await collected;
    const done = seen.at(-1) as Extract<StudioEvent, { kind: "done" }>;
    expect(done.isTurn).toBe(true);
    expect(done.answer).toBe("Wrote **scripts/ping.ps1**.");
    expect(done.status?.[0]).toMatch(/✓ done · 1 tool · ↑ 1.8k ↓ 120/);
    expect(kinds).toEqual(expect.arrayContaining(["started", "tool_start", "approval", "approval_done", "tool", "text_delta", "done"]));
    expect(await readFile(path.join(cwd, "scripts", "ping.ps1"), "utf8")).toBe("Test-Connection 127.0.0.1");
    expect(loadSettings(cwd).rules.allow).toContain("write scripts/*");
    const state = await api("/api/state");
    expect(state.data.tokens).toEqual({ input: 1800, output: 120 });
    const messages = await api("/api/messages");
    expect((messages.data as unknown as Array<{ role: string; text: string }>).map((m) => m.role)).toEqual(["user", "tool", "assistant"]);
  });

  it("switches model and thinking through the same commands the terminal uses", async () => {
    const { api } = await studio();
    const models = await api("/api/models");
    expect((models.data as unknown as Array<{ id: string }>)[0]?.id).toBe("auto");
    const picked = await api("/api/model", { id: "glm-5.3-flash" });
    expect(picked.data.output).toContain("glm-5.3-flash (pinned)");
    await api("/api/think", { value: "high" });
    await api("/api/think", { value: "show" });
    const state = await api("/api/state");
    expect(state.data.model).toBe("glm-5.3-flash");
    expect(state.data.thinking).toEqual({ level: "high", display: "show" });
    expect((await api("/api/prompt", { text: "/exit" })).status).toBe(400);
  });

  it("Stop settles a waiting approval as No, and nothing is written", async () => {
    const { base, server, api, cwd } = await studio();
    const collected = events(base, server.token, (e) => e.kind === "done" || e.kind === "error", (e) => {
      if (e.kind === "approval") void api("/api/stop", {});
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api("/api/prompt", { text: "add a ping script" });
    const seen = await collected;
    expect(seen.some((e) => e.kind === "approval_done" && e.answer === false)).toBe(true);
    expect(existsSync(path.join(cwd, "scripts", "ping.ps1"))).toBe(false);
  });

  it("new chat and resume go through /new and /resume", async () => {
    const { api, server } = await studio();
    const first = server.state.session.id;
    await api("/api/new", {});
    expect(server.state.session.id).not.toBe(first);
    await api("/api/resume", { id: first });
    expect(server.state.session.id).toBe(first);
  });
});

describe("displayMessages", () => {
  it("turns session rows into prompts, answers and one line per tool", () => {
    const at = "2026-09-25T00:00:00Z";
    expect(
      displayMessages([
        { role: "user", content: "go", at },
        { role: "assistant", at, content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: { path: "a.md" } }] },
        { role: "tool", at, content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: "x" } }] },
        { role: "assistant", at, content: [{ type: "text", text: "done" }] },
      ]),
    ).toEqual([
      { role: "user", text: "go" },
      { role: "tool", text: "read a.md" },
      { role: "assistant", text: "done" },
    ]);
  });
});
