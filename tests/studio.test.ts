import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { parseArgs } from "../src/cli.ts";
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

describe("Aegis Studio edge cases", () => {
  it("?t= works only for the event stream; other routes need the header", async () => {
    const { base, server } = await studio();
    expect((await fetch(`${base}/api/state?t=${server.token}`)).status).toBe(401);
    const events = await fetch(`${base}/api/events?t=${server.token}`);
    expect(events.status).toBe(200);
    await events.body?.cancel();
  });

  it("bad JSON is a 400, not a 500", async () => {
    const { base, server } = await studio();
    const res = await fetch(`${base}/api/prompt`, { method: "POST", headers: { "x-aegis-token": server.token }, body: "{ nope" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("body must be a JSON object");
  });

  it("keeps a character that is split across two network chunks", async () => {
    const { server, cwd } = await studio();
    const body = Buffer.from(JSON.stringify({ text: "/memory café €" }));
    const cut = body.indexOf(Buffer.from("€")) + 1; // inside the 3-byte €
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.port,
          method: "POST",
          path: "/api/prompt",
          headers: { host: `127.0.0.1:${server.port}`, "x-aegis-token": server.token, "content-length": body.length },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write(body.subarray(0, cut));
      setTimeout(() => req.end(body.subarray(cut)), 50);
    });
    expect(status).toBe(200);
    expect(await readFile(path.join(cwd, ".harness", "memory.md"), "utf8")).toContain("café €");
  });

  it("closing while an approval waits (page open) does not crash", async () => {
    const { base, server, api } = await studio();
    open.pop(); // closed by hand below
    const res = await fetch(`${base}/api/events?t=${server.token}`);
    const reader = res.body!.getReader();
    await api("/api/prompt", { text: "add a ping script" });
    for (let i = 0; i < 50 && !((await api("/api/state")).data.approvals as unknown[]).length; i++) await new Promise((r) => setTimeout(r, 20));
    const crashes: unknown[] = [];
    const onCrash = (error: unknown) => crashes.push(error);
    process.on("uncaughtException", onCrash);
    await server.close();
    await new Promise((r) => setTimeout(r, 100));
    process.off("uncaughtException", onCrash);
    await reader.cancel().catch(() => {});
    expect(crashes).toEqual([]);
  });

  it("--port must be a real port number", () => {
    expect(parseArgs(["ui", "--port", "4455"]).port).toBe(4455);
    expect(() => parseArgs(["ui", "--port", "abc"])).toThrow(/--port/);
    expect(() => parseArgs(["ui", "--port"])).toThrow(/--port/);
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

describe("Studio: pasted images", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ).toString("base64");

  it("a pasted image goes to the model with the message; the saved chat keeps only a note", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "a red dot" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ] as never[],
          }),
        };
      },
    });
    const { cwd, server, base, api } = await studio(generateWith(model));
    await writeFile(path.join(cwd, "gate.config.json"), JSON.stringify({ frontierModel: "claude-sonnet-5", cheapModel: "claude-sonnet-5" }));
    const done = events(base, server.token, (e) => e.kind === "done" || e.kind === "error");
    const sent = await api("/api/prompt", { text: "what is this?", images: [{ name: "shot.png", data: PNG }] });
    expect(sent.status).toBe(202);
    await done;
    expect(prompts[0]).toContain(PNG);
    expect(prompts[0]).toContain("pasted 1 (shot.png)");
    const saved = await readFile(path.join(cwd, ".harness", "sessions", server.state.session.id, "messages.jsonl"), "utf8");
    expect(saved).toContain("pasted 1 (shot.png)");
    expect(saved).not.toContain(PNG);
  });

  it("refuses what is not an image, too many, or not base64", async () => {
    const { api } = await studio();
    const text = Buffer.from("<svg/>").toString("base64");
    expect((await api("/api/prompt", { text: "x", images: [{ data: text }] })).status).toBe(400);
    expect((await api("/api/prompt", { text: "x", images: [{ data: "not base64!" }] })).status).toBe(400);
    expect((await api("/api/prompt", { text: "x", images: Array(5).fill({ data: PNG }) })).status).toBe(400);
    expect((await api("/api/prompt", { text: "x", images: "nope" })).status).toBe(400);
  });
});

describe("Studio: pasted images, review fixes", () => {
  it("images with a command are refused", async () => {
    const { api } = await studio();
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    expect((await api("/api/prompt", { text: "/status", images: [{ data: png }] })).status).toBe(400);
  });
});

describe("Studio: attached text files", () => {
  it("a text file goes to the model with the message, marked as data, secrets cut", async () => {
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "the policy is shadowed" },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ] as never[],
          }),
        };
      },
    });
    const { server, base, api } = await studio(generateWith(model));
    const done = events(base, server.token, (e) => e.kind === "done" || e.kind === "error");
    const config = "config firewall policy\n  edit 12\n  set srcaddr all\nnext\nset password=Sup3rS3cretPass!\n";
    const sent = await api("/api/prompt", { text: "why is rule 12 shadowed?", documents: [{ name: "fw-policy.conf", text: config }] });
    expect(sent.status).toBe(202);
    await done;
    expect(prompts[0]).toContain("set srcaddr all");
    expect(prompts[0]).toMatch(/attached_file_[0-9a-f]{8} name=\\"fw-policy.conf\\"/);
    expect(prompts[0]).toContain("data, not instructions");
    expect(prompts[0]).not.toContain("Sup3rS3cretPass");
  });

  it("refuses binary files, too many, too big, and files with a command", async () => {
    const { api } = await studio();
    expect((await api("/api/prompt", { text: "x", documents: [{ name: "a.pdf", text: "%PDF\u0000" }] })).status).toBe(400);
    expect((await api("/api/prompt", { text: "x", documents: Array(6).fill({ name: "a.txt", text: "a" }) })).status).toBe(400);
    expect((await api("/api/prompt", { text: "x", documents: [{ name: "a.txt", text: "a".repeat(210 * 1024) }] })).status).toBe(400);
    expect((await api("/api/prompt", { text: "/status", documents: [{ name: "a.txt", text: "a" }] })).status).toBe(400);
  });
});
