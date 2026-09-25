import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexRequestBody, freshCodexCredential, loginCodexBrowser } from "../src/auth/codex.ts";
import { authFile, loadCredential, saveCredential } from "../src/auth/store.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { resolveProvider } from "../src/providers.ts";
import type { TurnEvent } from "../src/types.ts";

/** A JWT-shaped token (unsigned) carrying the ChatGPT account claim, like auth.openai.com issues. */
function jwt(claims: Record<string, unknown>) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}
const access = (n: number) => jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-42" }, n });

type Seen = { path: string; headers: IncomingMessage["headers"]; body: string };

/** Stand-in for auth.openai.com and chatgpt.com/backend-api/codex. */
async function fakeOpenAI(options: { codexTurns?: Array<(body: Record<string, unknown>) => string> } = {}) {
  const seen: Seen[] = [];
  let polls = 0;
  let issued = 0;
  let challenge = "";
  let redirect = "";
  const codexTurns = [...(options.codexTurns ?? [])];
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push({ path: url.pathname, headers: req.headers, body });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/accounts/deviceauth/usercode") return json(200, { device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" });
    if (url.pathname === "/api/accounts/deviceauth/token") {
      polls += 1;
      if (polls < 2) return json(403, { error: { code: "deviceauth_authorization_pending" } });
      return json(200, { authorization_code: "device-code", code_verifier: "device-verifier" });
    }
    if (url.pathname === "/oauth/authorize") {
      challenge = url.searchParams.get("code_challenge") ?? "";
      redirect = url.searchParams.get("redirect_uri") ?? "";
      res.writeHead(302, { location: `${redirect}?code=browser-code&state=${url.searchParams.get("state")}` });
      return res.end();
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code" && form.get("code") === "browser-code") {
        const verifier = form.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== challenge) return json(400, { error: "bad pkce" });
      }
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") !== "refresh-1") return json(400, { error: "bad refresh" });
      issued += 1;
      return json(200, {
        access_token: access(issued),
        refresh_token: "refresh-1",
        expires_in: 3600,
        id_token: jwt({ email: "vikas@example.com" }),
      });
    }
    if (url.pathname === "/codex/responses") {
      const turn = codexTurns.shift();
      if (!turn) return json(500, { error: "no scripted turn" });
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(turn(JSON.parse(body) as Record<string, unknown>));
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { seen, base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())), polls: () => polls };
}

const sse = (events: object[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
const usage = { input_tokens: 1200, output_tokens: 40, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const created = { type: "response.created", response: { id: "resp-1", created_at: 1, model: "gpt-5.5" } };
const textTurn = (text: string) => () =>
  sse([
    created,
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg-1" } },
    { type: "response.output_text.delta", item_id: "msg-1", delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg-1" } },
    { type: "response.completed", response: { usage } },
  ]);
const toolTurn = () =>
  sse([
    created,
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "read", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 0, delta: '{"path":"README.md"}' },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "read", arguments: '{"path":"README.md"}', status: "completed" },
    },
    { type: "response.completed", response: { usage } },
  ]);

const saved = { ...process.env };
let home = "";
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "aegis-chatgpt-home-"));
  process.env.AEGIS_HOME = home;
  process.env.AEGIS_NO_BROWSER = "1";
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AEGIS_PROVIDER;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("/login chatgpt (device code)", () => {
  it("shows the code, waits for approval, saves the sign-in, and switches the provider", async () => {
    const fake = await fakeOpenAI();
    process.env.AEGIS_CODEX_AUTH_URL = fake.base;
    try {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-chatgpt-"));
      const state = await startState(cwd, { mockJev: true });
      expect(state.provider).toBe("local");
      const notices: string[] = [];
      const result = await handleLine("/login chatgpt", state, { mockJev: true, yes: false }, undefined, (event: TurnEvent) => {
        if (event.type === "notice") notices.push(event.text);
      });
      expect(notices[0]).toContain(`${fake.base}/codex/device`);
      expect(notices[0]).toContain("ABCD-1234");
      expect(fake.polls()).toBe(2);
      expect(result.output).toContain("Signed in to ChatGPT as vikas@example.com");
      expect(state.provider).toBe("codex");
      const credential = loadCredential("chatgpt");
      expect(credential?.accountId).toBe("acct-42");
      expect(credential?.refresh).toBe("refresh-1");
      // The token exchange used the device verifier and the device redirect.
      const exchange = new URLSearchParams(fake.seen.find((row) => row.path === "/oauth/token")!.body);
      expect(exchange.get("code_verifier")).toBe("device-verifier");
      expect(exchange.get("redirect_uri")).toBe(`${fake.base}/deviceauth/callback`);
      // The key is never shown in /login; the sign-in is.
      expect((await handleLine("/login", state, { mockJev: true, yes: false })).output).toContain("chatgpt   signed in as vikas@example.com");
      expect((await handleLine("/logout chatgpt", state, { mockJev: true, yes: false })).output).toContain("signed out");
      expect(loadCredential("chatgpt")).toBeUndefined();
      expect(state.provider).toBe("local");
    } finally {
      await fake.close();
    }
  });

  it("esc cancels a sign-in that is still waiting", async () => {
    const fake = await fakeOpenAI();
    process.env.AEGIS_CODEX_AUTH_URL = fake.base;
    try {
      const state = await startState(await mkdtemp(path.join(os.tmpdir(), "aegis-chatgpt-")), { mockJev: true });
      const abort = new AbortController();
      const pending = handleLine("/login chatgpt", state, { mockJev: true, yes: false, abortSignal: abort.signal }, undefined, (event) => {
        if (event.type === "notice") abort.abort();
      });
      await expect(pending).rejects.toThrow(/cancelled/);
      expect(existsSync(authFile())).toBe(false);
    } finally {
      await fake.close();
    }
  });
});

describe("browser sign-in (PKCE)", () => {
  it("round-trips through the local callback and proves the PKCE verifier", async () => {
    const fake = await fakeOpenAI();
    process.env.AEGIS_CODEX_AUTH_URL = fake.base;
    try {
      const credential = await loginCodexBrowser(
        { show: () => {}, openUrl: (url) => void fetch(url) }, // the "browser" follows the redirect to our callback
        { port: 18455 },
      );
      expect(credential.accountId).toBe("acct-42");
      const authorize = fake.seen.find((row) => row.path === "/oauth/authorize");
      expect(authorize).toBeDefined();
    } finally {
      await fake.close();
    }
  });
});

describe("token refresh", () => {
  it("renews a token that is about to expire, once, and saves it", async () => {
    const fake = await fakeOpenAI();
    process.env.AEGIS_CODEX_AUTH_URL = fake.base;
    try {
      saveCredential("chatgpt", { access: access(0), refresh: "refresh-1", expires: Date.now() + 60_000, accountId: "acct-42" });
      const [a, b] = await Promise.all([freshCodexCredential(), freshCodexCredential()]);
      expect(a.access).toBe(b.access);
      expect(fake.seen.filter((row) => row.path === "/oauth/token")).toHaveLength(1);
      expect(loadCredential("chatgpt")?.access).toBe(a.access);
      // Still fresh: no second refresh.
      await freshCodexCredential();
      expect(fake.seen.filter((row) => row.path === "/oauth/token")).toHaveLength(1);
    } finally {
      await fake.close();
    }
  });

  it("a refresh that fails asks you to sign in again", async () => {
    const fake = await fakeOpenAI();
    process.env.AEGIS_CODEX_AUTH_URL = fake.base;
    try {
      saveCredential("chatgpt", { access: access(0), refresh: "revoked", expires: 0, accountId: "acct-42" });
      await expect(freshCodexCredential()).rejects.toThrow(/Run \/login chatgpt/);
    } finally {
      await fake.close();
    }
  });
});

describe("the Codex request", () => {
  it("moves system text into instructions, never stores, always streams, drops fields Codex rejects", () => {
    const body = codexRequestBody({
      model: "gpt-5.5",
      input: [
        { role: "developer", content: "RULES" },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      max_output_tokens: 900,
      temperature: 0.2,
      store: true,
      stream: false,
      metadata: { a: 1 },
      tools: [],
    });
    expect(body).toEqual({
      model: "gpt-5.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      instructions: "RULES",
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      tools: [],
    });
  });

  it("a full turn with a tool call runs on the ChatGPT plan: headers, body, tool result, answer, tokens", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fake = await fakeOpenAI({
      codexTurns: [
        (body) => (bodies.push(body), toolTurn()),
        (body) => (bodies.push(body), textTurn("The README says hello.")()),
      ],
    });
    process.env.AEGIS_CODEX_AUTH_URL = fake.base;
    process.env.AEGIS_CODEX_BASE_URL = `${fake.base}/codex`;
    try {
      saveCredential("chatgpt", { access: access(7), refresh: "refresh-1", expires: Date.now() + 3_600_000, accountId: "acct-42" });
      expect(resolveProvider()).toBe("codex");
      const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-chatgpt-turn-"));
      await writeFile(path.join(cwd, "README.md"), "hello\n");
      const state = await startState(cwd, { mockJev: true });
      expect(state.provider).toBe("codex");
      await handleLine("/model gpt-5.5", state, { mockJev: true, yes: false });
      const result = await handleLine("what does the README say?", state, { mockJev: true, yes: false });
      expect(result.receipt?.answer).toBe("The README says hello.");
      expect(result.receipt?.tools[0]).toMatchObject({ name: "read", approved: true });
      expect(result.receipt?.tokens).toMatchObject({ input: 2400, output: 80 });
      const calls = fake.seen.filter((row) => row.path === "/codex/responses");
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.headers.authorization).toBe(`Bearer ${access(7)}`);
        expect(call.headers["chatgpt-account-id"]).toBe("acct-42");
        expect(call.headers.originator).toBe("aegis");
      }
      for (const body of bodies) {
        expect(body.store).toBe(false);
        expect(body.stream).toBe(true);
        expect(String(body.instructions)).toContain("Aegis");
        expect(body).not.toHaveProperty("max_output_tokens");
        expect((body.input as Array<{ role?: string }>).some((item) => item.role === "system" || item.role === "developer")).toBe(false);
      }
      // Step 2 carries the tool call and its result inline (nothing is stored server-side, so no item references).
      const second = JSON.stringify(bodies[1]!.input);
      expect(second).toContain("function_call_output");
      expect(second).toContain("hello");
      expect(second).not.toContain("item_reference");
      expect(await readFile(authFile(), "utf8")).toContain("acct-42");
    } finally {
      await fake.close();
    }
  });
});
