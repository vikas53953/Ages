/**
 * Sign in with ChatGPT (Plus / Pro / Business) and use the plan's Codex models.
 *
 * The flows follow Pi (pi-mono, MIT) and OpenAI's Codex CLI: the public Codex CLI client id, a device code
 * (you type a short code on auth.openai.com) or a browser sign-in with PKCE on http://localhost:1455.
 * Requests go to the ChatGPT Codex endpoint with your token; `originator: aegis` says who is calling.
 * OpenAI staff have said ChatGPT plans may be used from third-party harnesses such as Pi and OpenCode.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { loadCredential, saveCredential, type OAuthCredential } from "./store.ts";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
export const CODEX_CREDENTIAL = "chatgpt";

/** Overridable so tests (and enterprise proxies) can point elsewhere. */
export function codexAuthBase() {
  return (process.env.AEGIS_CODEX_AUTH_URL || "https://auth.openai.com").replace(/\/+$/, "");
}
export function codexApiBase() {
  return (process.env.AEGIS_CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
}

/** How /login talks to you while it waits: a line to show, and a way to cancel. */
export type LoginUi = { show: (text: string) => void; signal?: AbortSignal; openUrl?: (url: string) => void };

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string };

function decodeJwt(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The ChatGPT account the token belongs to; every Codex request must name it. */
export function accountIdFrom(access: string) {
  const auth = decodeJwt(access)?.[JWT_AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
  return typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id ? auth.chatgpt_account_id : undefined;
}

function toCredential(json: TokenResponse, previousRefresh?: string): OAuthCredential {
  const refresh = json.refresh_token ?? previousRefresh;
  if (!json.access_token || !refresh || typeof json.expires_in !== "number") {
    throw new Error("ChatGPT sign-in: the token response was missing fields");
  }
  const accountId = accountIdFrom(json.access_token);
  if (!accountId) throw new Error("ChatGPT sign-in: no ChatGPT account in the token (is this a ChatGPT plan?)");
  const email = json.id_token ? (decodeJwt(json.id_token)?.email as string | undefined) : undefined;
  return { access: json.access_token, refresh, expires: Date.now() + json.expires_in * 1000, accountId, email };
}

async function tokenRequest(body: Record<string, string>, signal?: AbortSignal) {
  const response = await fetch(`${codexAuthBase()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CODEX_CLIENT_ID, ...body }),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ChatGPT sign-in: token request failed (${response.status}) ${text.slice(0, 200)}`.trim());
  }
  return (await response.json()) as TokenResponse;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("sign-in cancelled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("sign-in cancelled"));
      },
      { once: true },
    );
  });

/** Device code: works behind firewalls and over remote desktop, no local port needed. */
export async function loginCodexDevice(ui: LoginUi, options: { pollMs?: number; timeoutMs?: number } = {}) {
  const base = codexAuthBase();
  const start = await fetch(`${base}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    signal: ui.signal,
  });
  if (!start.ok) {
    throw new Error(
      start.status === 404
        ? "ChatGPT device sign-in is not available right now. Try: /login chatgpt browser"
        : `ChatGPT sign-in: could not start (${start.status})`,
    );
  }
  const device = (await start.json()) as { device_auth_id?: string; user_code?: string; interval?: number | string };
  if (!device.device_auth_id || !device.user_code) throw new Error("ChatGPT sign-in: unexpected reply from auth.openai.com");
  const verifyUrl = `${base}/codex/device`;
  ui.show(`Open ${verifyUrl} and enter the code  ${device.user_code}\nWaiting for you to finish in the browser… (esc cancels)`);
  ui.openUrl?.(verifyUrl);

  let interval = options.pollMs ?? Math.max(1, Number(device.interval ?? 5)) * 1000;
  const deadline = Date.now() + (options.timeoutMs ?? DEVICE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await sleep(interval, ui.signal);
    const poll = await fetch(`${base}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
      signal: ui.signal,
    });
    if (poll.ok) {
      const code = (await poll.json()) as { authorization_code?: string; code_verifier?: string };
      if (!code.authorization_code || !code.code_verifier) throw new Error("ChatGPT sign-in: unexpected reply while waiting");
      const tokens = await tokenRequest(
        {
          grant_type: "authorization_code",
          code: code.authorization_code,
          code_verifier: code.code_verifier,
          redirect_uri: `${base}/deviceauth/callback`,
        },
        ui.signal,
      );
      return toCredential(tokens);
    }
    if (poll.status === 403 || poll.status === 404) continue; // not approved yet
    const text = await poll.text().catch(() => "");
    if (/authorization_pending/.test(text)) continue;
    if (/slow_down/.test(text)) {
      interval += 5000;
      continue;
    }
    throw new Error(`ChatGPT sign-in failed (${poll.status}) ${text.slice(0, 200)}`.trim());
  }
  throw new Error("ChatGPT sign-in timed out (15 minutes). Run /login chatgpt again.");
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Browser sign-in: opens auth.openai.com; the page comes back to http://localhost:1455 on this PC. */
export async function loginCodexBrowser(ui: LoginUi, options: { port?: number } = {}) {
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("hex");
  const port = options.port ?? CALLBACK_PORT;
  const redirectUri = options.port ? `http://localhost:${port}/auth/callback` : REDIRECT_URI;
  const url = new URL(`${codexAuthBase()}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "aegis",
  })) {
    url.searchParams.set(key, value);
  }

  let settle!: (result: { code?: string; error?: string }) => void;
  const result = new Promise<{ code?: string; error?: string }>((resolve) => (settle = resolve));
  const page = (text: string) =>
    `<!doctype html><meta charset="utf-8"><title>Aegis</title><body style="font:16px system-ui;padding:40px">${text}</body>`;
  const server = createServer((req, res) => {
    const callback = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (callback.pathname !== "/auth/callback") {
      res.writeHead(404).end();
      return;
    }
    const code = callback.searchParams.get("code");
    const ok = callback.searchParams.get("state") === state && Boolean(code);
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(page(ok ? "Signed in to ChatGPT. You can close this tab and go back to Aegis." : "Sign-in failed. Go back to Aegis and try again."));
    settle(ok ? { code: code! } : { error: callback.searchParams.get("error") ?? "state mismatch" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? `port ${port} is busy (is the Codex CLI signing in?). Use: /login chatgpt  (device code)`
            : error.message,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const onAbort = () => settle({ error: "sign-in cancelled" });
  ui.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    ui.show(`Sign in in your browser. If it did not open, go to:\n${url.toString()}\nWaiting… (esc cancels)`);
    ui.openUrl?.(url.toString());
    const answer = await result;
    if (!answer.code) throw new Error(`ChatGPT sign-in failed: ${answer.error}`);
    const tokens = await tokenRequest(
      { grant_type: "authorization_code", code: answer.code, code_verifier: verifier, redirect_uri: redirectUri },
      ui.signal,
    );
    return toCredential(tokens);
  } finally {
    ui.signal?.removeEventListener("abort", onAbort);
    server.close();
  }
}

export async function refreshCodex(credential: OAuthCredential, signal?: AbortSignal) {
  const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: credential.refresh }, signal);
  return toCredential(tokens, credential.refresh);
}

export function hasCodexLogin() {
  return Boolean(loadCredential(CODEX_CREDENTIAL));
}

let refreshing: Promise<OAuthCredential> | undefined;

/** A token good for at least five more minutes; refreshes (once, even if many calls ask at the same time). */
export async function freshCodexCredential(options: { force?: boolean; signal?: AbortSignal } = {}) {
  const saved = loadCredential(CODEX_CREDENTIAL);
  if (!saved) throw new Error("Not signed in to ChatGPT. Run /login chatgpt");
  if (!options.force && saved.expires - Date.now() > REFRESH_MARGIN_MS) return saved;
  refreshing ??= refreshCodex(saved, options.signal)
    .then((next) => {
      saveCredential(CODEX_CREDENTIAL, next);
      return next;
    })
    .catch((error: unknown) => {
      throw new Error(`ChatGPT sign-in expired and could not be renewed (${error instanceof Error ? error.message : String(error)}). Run /login chatgpt`);
    })
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

const KEEP = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "prompt_cache_key",
  "text",
]);

function contentText(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
  }
  return "";
}

/**
 * The Codex endpoint is stricter than the public Responses API: system text must be in `instructions`,
 * nothing may be stored server-side, it always streams, and it rejects fields such as max_output_tokens.
 */
export function codexRequestBody(body: Record<string, unknown>) {
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : [];
  const system = input.filter((item) => item.role === "system" || item.role === "developer").map((item) => contentText(item.content));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) if (KEEP.has(key)) out[key] = value;
  out.input = input.filter((item) => item.role !== "system" && item.role !== "developer");
  const instructions = [typeof body.instructions === "string" ? body.instructions : "", ...system].filter(Boolean).join("\n\n");
  out.instructions = instructions || "You are Aegis, a coding assistant.";
  out.store = false;
  out.stream = true;
  const include = new Set(Array.isArray(body.include) ? (body.include as string[]) : []);
  include.add("reasoning.encrypted_content");
  out.include = [...include];
  return out;
}

/** fetch for the AI SDK's OpenAI provider: adds your ChatGPT sign-in and reshapes the body; renews once on 401. */
export function codexFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    let body = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.stringify(codexRequestBody(JSON.parse(body) as Record<string, unknown>));
      } catch {
        // not JSON: send as is
      }
    }
    const send = async (credential: OAuthCredential) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      headers.set("authorization", `Bearer ${credential.access}`);
      headers.set("chatgpt-account-id", credential.accountId ?? accountIdFrom(credential.access) ?? "");
      headers.set("originator", "aegis");
      headers.set("OpenAI-Beta", "responses=experimental");
      headers.set("accept", "text/event-stream");
      return base(input, { ...init, headers, body });
    };
    const signal = init?.signal ?? undefined;
    const first = await send(await freshCodexCredential({ signal }));
    if (first.status !== 401) return first;
    return send(await freshCodexCredential({ force: true, signal }));
  };
}
