/**
 * Aegis Studio: the browser face. `aegis ui` serves a page from your own PC and drives the same core as the
 * terminal (handleLine: rules, Jev, plugins, sessions). Nothing leaves 127.0.0.1.
 *
 * Security: bound to 127.0.0.1 only; every /api call needs the random token printed in the URL; the Host header
 * must be 127.0.0.1 or localhost on our port (stops DNS-rebinding pages); no CORS headers, so other sites cannot
 * read responses. A waiting approval stays until you answer it: reopen the link to see the card again, or
 * stop the turn (Stop, or ctrl+c in the terminal), which answers No.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { packageRoot } from "./env.ts";
import type { TurnEvent } from "./loop.ts";
import { loadSettingsSafe, thinkingOf } from "./rules.ts";
import {
  closeState,
  currentTodos,
  handleLine,
  modelChoices,
  startState,
  welcomeInfo,
  type AppState,
  type HandleResult,
  type RunOpts,
} from "./runtime.ts";
import { loadMessages, messageText, recentSessions, type ChatMessage } from "./session.ts";
import { turnStatusLines } from "./tui-layout.ts";
import type { ConfirmAnswer, ConfirmOptions } from "./types.ts";
import { gitBranch } from "./git-head.ts";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN, sniffImage, type ImageAttachment } from "./images.ts";
import { docxText, looksLikePdf, MAX_DOCX_BYTES, MAX_PDF_BYTES, pdfText } from "./documents.ts";

export type StudioEvent =
  | { kind: "event"; event: TurnEvent }
  | { kind: "approval"; id: number; question: string; options?: Omit<ConfirmOptions, "card"> }
  | { kind: "approval_done"; id: number; answer: ConfirmAnswer }
  | { kind: "started"; text: string }
  | {
      kind: "done";
      output: string;
      notice?: string;
      answer?: string;
      status?: string[];
      tokens?: { input: number; output: number; reasoning?: number };
      isTurn: boolean;
      /** The conversation changed under the page (/fork, /rewind chat, /resume): reload it. */
      chat?: "keep" | "reset" | "reload";
    }
  | { kind: "error"; message: string };

/** Files attached from the page: at most 5; text files 200 KB each, PDFs and Word files 10 MB each and 20 MB together. */
const MAX_DOCUMENTS = 5;
const MAX_DOCUMENT_CHARS = 200 * 1024;
const MAX_PDF_TOTAL_BYTES = 2 * MAX_PDF_BYTES;
/** 4 images of 5 MB as base64, 5 text files, the PDFs and Word files as base64, plus the text. */
const PROMPT_BODY_LIMIT =
  Math.ceil((MAX_IMAGES_PER_TURN * MAX_IMAGE_BYTES * 4) / 3) +
  MAX_DOCUMENTS * MAX_DOCUMENT_CHARS * 2 +
  Math.ceil((MAX_PDF_TOTAL_BYTES * 4) / 3) +
  1_000_000;

export type PastedDocument = { name: string; text: string } | { name: string; pdf: Buffer } | { name: string; docx: Buffer };

/**
 * Files attached on the page: text files (logs, configs, scripts) as text, PDFs and Word files as base64 (their text
 * is pulled out on this side, so the page cannot hand the model anything but text). Anything else is a 400.
 */
export function pastedDocuments(value: unknown): PastedDocument[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequest("documents must be a list");
  if (value.length > MAX_DOCUMENTS) throw new BadRequest(`at most ${MAX_DOCUMENTS} files per message`);
  let pdfBytes = 0;
  return value.map((item) => {
    const entry = (item ?? {}) as { name?: unknown; text?: unknown; pdf?: unknown; docx?: unknown };
    const fallback = entry.pdf !== undefined ? "file.pdf" : entry.docx !== undefined ? "file.docx" : "file.txt";
    const name = typeof entry.name === "string" ? entry.name.replace(/[^\w. -]+/g, "_").slice(0, 80) || fallback : fallback;
    if (entry.pdf !== undefined) {
      if (typeof entry.pdf !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.pdf)) throw new BadRequest("a PDF is not base64");
      const buf = Buffer.from(entry.pdf, "base64");
      if (buf.length > MAX_PDF_BYTES) throw new BadRequest(`a PDF is over ${MAX_PDF_BYTES / 1024 / 1024} MB`);
      pdfBytes += buf.length;
      if (pdfBytes > MAX_PDF_TOTAL_BYTES) throw new BadRequest(`PDFs and Word files are limited to ${MAX_PDF_TOTAL_BYTES / 1024 / 1024} MB per message`);
      if (!looksLikePdf(buf)) throw new BadRequest(`${name} is not a PDF file`);
      return { name, pdf: buf };
    }
    if (entry.docx !== undefined) {
      if (typeof entry.docx !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.docx)) throw new BadRequest("a Word file is not base64");
      const buf = Buffer.from(entry.docx, "base64");
      if (buf.length > MAX_DOCX_BYTES) throw new BadRequest(`a Word file is over ${MAX_DOCX_BYTES / 1024 / 1024} MB`);
      pdfBytes += buf.length;
      if (pdfBytes > MAX_PDF_TOTAL_BYTES) throw new BadRequest(`PDFs and Word files are limited to ${MAX_PDF_TOTAL_BYTES / 1024 / 1024} MB per message`);
      // Whether it really is a .docx is checked when it is read (docxText), with a plain-words reason.
      return { name, docx: buf };
    }
    if (typeof entry.text !== "string") throw new BadRequest("a file has no text");
    if (entry.text.length > MAX_DOCUMENT_CHARS) throw new BadRequest("a file is over 200 KB");
    if (entry.text.includes("\u0000")) throw new BadRequest("only text files, PDFs and Word (.docx) files can be attached (this one is binary)");
    return { name, text: entry.text };
  });
}

/** Each attached file as text: a PDF's or Word file's text is read here (one at a time); one that cannot be read is a 400. */
export async function attachedTexts(documents: PastedDocument[] | undefined, signal?: AbortSignal) {
  if (!documents) return undefined;
  const out: Array<{ name: string; text: string }> = [];
  for (const document of documents) {
    if ("text" in document) {
      out.push(document);
      continue;
    }
    try {
      const text = "pdf" in document ? await pdfText(document.pdf, document.name, { signal }) : await docxText(document.docx, document.name, { signal });
      out.push({ name: document.name, text });
    } catch (error) {
      throw new BadRequest(error instanceof Error ? error.message : String(error));
    }
  }
  return out;
}

/**
 * Images pasted or dropped on the page: at most 4, each checked by its first bytes and size. Anything else is
 * refused with a 400, so a page bug cannot send the model a file it did not mean to.
 */
export function pastedImages(value: unknown): ImageAttachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new BadRequest("images must be a list");
  if (value.length > MAX_IMAGES_PER_TURN) throw new BadRequest(`at most ${MAX_IMAGES_PER_TURN} images per message`);
  return value.map((item, index) => {
    const entry = (item ?? {}) as { name?: unknown; data?: unknown };
    if (typeof entry.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data)) throw new BadRequest("an image is not base64");
    const buf = Buffer.from(entry.data, "base64");
    if (buf.length > MAX_IMAGE_BYTES) throw new BadRequest("an image is over 5 MB");
    const mediaType = sniffImage(buf);
    if (!mediaType) throw new BadRequest("only PNG, JPEG, GIF and WebP images can be pasted");
    const name = typeof entry.name === "string" ? entry.name.replace(/[^\w.-]+/g, "_").slice(0, 60) : "";
    return { path: `pasted ${index + 1}${name ? ` (${name})` : ""}`, mediaType, bytes: buf.length, data: buf.toString("base64") };
  });
}

class BadRequest extends Error {}

type Pending = { resolve: (answer: ConfirmAnswer) => void; question: string; options?: ConfirmOptions };

const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/app.css": "app.css",
};
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** Session rows → what the page shows: your prompts, the answers, and one line per tool call. */
export function displayMessages(rows: ChatMessage[]) {
  const out: Array<{ role: "user" | "assistant" | "tool"; text: string }> = [];
  for (const row of rows) {
    if (row.role === "tool") continue;
    if (typeof row.content === "string") {
      if (row.content.trim()) out.push({ role: row.role, text: row.content });
      continue;
    }
    for (const part of row.content) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        out.push({ role: row.role, text: part.text });
      } else if (part.type === "tool-call") {
        const input = (part.input ?? {}) as Record<string, unknown>;
        const target = String(input.path ?? input.command ?? input.pattern ?? "");
        out.push({ role: "tool", text: `${String(part.toolName)} ${target}`.trim() });
      }
    }
  }
  if (!out.length) {
    for (const row of rows) if (messageText(row).trim()) out.push({ role: row.role === "user" ? "user" : "assistant", text: messageText(row) });
  }
  return out;
}

export async function startStudio(input: {
  cwd: string;
  opts: RunOpts;
  port?: number;
  continueSession?: boolean;
}) {
  const token = randomBytes(18).toString("hex");
  const state: AppState = await startState(input.cwd, { ...input.opts, newSession: !input.continueSession });
  const clients = new Set<ServerResponse>();
  const pending = new Map<number, Pending>();
  let nextApproval = 1;
  let busy = false;
  let turnAbort: AbortController | undefined;
  /** Set while attached PDFs and Word files are being read, before the turn starts: one at a time, and Stop ends it. */
  let preparing: AbortController | undefined;

  const send = (event: StudioEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) if (!client.writableEnded && !client.destroyed) client.write(frame);
  };

  const confirm = (question: string, options?: ConfirmOptions) =>
    new Promise<ConfirmAnswer>((resolve) => {
      const id = nextApproval++;
      const finish = (answer: ConfirmAnswer) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        send({ kind: "approval_done", id, answer });
        resolve(answer);
      };
      // The page draws its own card from the question and these facts; the terminal's card (the whole file) stays here.
      const { card: _card, ...shown } = options ?? {};
      pending.set(id, { resolve: finish, question, options: shown });
      turnAbort?.signal.addEventListener("abort", () => finish(false), { once: true });
      send({ kind: "approval", id, question, options: shown });
    });

  const run = async (text: string, images?: ImageAttachment[], documents?: Array<{ name: string; text: string }>): Promise<HandleResult | undefined> => {
    busy = true;
    turnAbort = new AbortController();
    send({ kind: "started", text });
    try {
      const result = await handleLine(
        text,
        state,
        { ...input.opts, abortSignal: turnAbort.signal, images, documents },
        confirm,
        // tool_input (a call still being written) is shown live in the terminal only, for now.
        (event) => (event.type === "tool_input" ? undefined : send({ kind: "event", event })),
      );
      const receipt = result.receipt;
      send({
        kind: "done",
        output: result.output,
        notice: result.notice,
        answer: receipt?.answer ?? undefined,
        status: receipt ? turnStatusLines(receipt) : undefined,
        tokens: receipt?.tokens,
        isTurn: Boolean(receipt),
        chat: result.chat,
      });
      return result;
    } catch (error) {
      send({ kind: "error", message: turnAbort.signal.aborted ? "stopped" : error instanceof Error ? error.message : String(error) });
      return undefined;
    } finally {
      for (const entry of pending.values()) entry.resolve(false);
      busy = false;
      turnAbort = undefined;
    }
  };

  const snapshot = async () => {
    const settings = loadSettingsSafe(state.cwd).settings;
    return {
      welcome: await welcomeInfo(state),
      session: state.session.id,
      model: state.modelMode === "pinned" ? state.model : "auto",
      provider: state.provider,
      jev: state.jevHealth,
      thinking: thinkingOf(settings),
      tokens: state.sessionTokens,
      plan: Boolean(state.planMode),
      todos: await currentTodos(state),
      plugins: state.plugins.map((plugin) => plugin.name),
      context: state.contextPercent ?? 0,
      branch: gitBranch(state.cwd),
      busy,
      approvals: [...pending.entries()].map(([id, entry]) => ({ id, question: entry.question, options: entry.options })),
    };
  };

  const readBody = async (req: IncomingMessage, limit = 1_000_000) => {
    // Decode as one UTF-8 stream so a character split across chunks is not mangled.
    req.setEncoding("utf8");
    let body = "";
    for await (const chunk of req) {
      body += chunk as string;
      if (body.length > limit) throw new BadRequest("request too large");
    }
    if (!body) return {};
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new BadRequest("body must be a JSON object");
    }
  };
  const tokenOk = (given: unknown) => {
    if (typeof given !== "string" || given.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };

  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };

  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const host = (req.headers.host ?? "").toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(res, 403, { error: "bad host" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");

      if (req.method === "GET" && STATIC[url.pathname]) {
        const file = path.join(packageRoot(), "studio", STATIC[url.pathname]!);
        const body = await readFile(file);
        res.writeHead(200, {
          "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        return res.end(body);
      }
      if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
      // The key comes in a header; only the event stream (EventSource cannot set headers) may use ?t=.
      const given = req.headers["x-aegis-token"] ?? (url.pathname === "/api/events" ? url.searchParams.get("t") : null);
      if (!tokenOk(given)) return json(res, 401, { error: "missing or wrong token" });

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": aegis\n\n");
        res.on("error", () => clients.delete(res));
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, await snapshot());
      if (req.method === "GET" && url.pathname === "/api/models") return json(res, 200, modelChoices(state));
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        return json(res, 200, { current: state.session.id, sessions: await recentSessions(state.cwd, 30) });
      }
      if (req.method === "GET" && url.pathname === "/api/messages") {
        return json(res, 200, displayMessages(await loadMessages(state.cwd, state.session.id)));
      }
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      // Refused before the body is read: a busy server does not take in 28 MB of images only to say no.
      if ((busy || preparing) && url.pathname !== "/api/approve" && url.pathname !== "/api/stop") {
        return json(res, 409, { error: "a turn is running; wait or stop it" });
      }
      // A prompt may carry pasted images (4 × 5 MB, as base64); everything else stays small.
      const body = await readBody(req, url.pathname === "/api/prompt" ? PROMPT_BODY_LIMIT : undefined);

      if (url.pathname === "/api/approve") {
        const entry = pending.get(Number(body.id));
        if (!entry) return json(res, 404, { error: "no such approval" });
        const answer = body.answer === "always" && entry.options?.always ? "always" : body.answer === "yes";
        entry.resolve(answer);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/stop") {
        turnAbort?.abort();
        preparing?.abort();
        return json(res, 200, { ok: true });
      }
      if (busy || preparing) return json(res, 409, { error: "a turn is running; wait or stop it" });

      // Commands the page sends as buttons; they run exactly as if typed in the terminal.
      let line = "";
      if (url.pathname === "/api/prompt") line = String(body.text ?? "").trim();
      else if (url.pathname === "/api/model") line = `/model ${String(body.id ?? "").trim()}`;
      else if (url.pathname === "/api/think") line = `/think ${String(body.value ?? "").trim()}`;
      else if (url.pathname === "/api/new") line = "/new";
      else if (url.pathname === "/api/resume") line = `/resume ${String(body.id ?? "").trim()}`;
      else return json(res, 404, { error: "not found" });
      if (!line || /^\/(exit|quit|q)$/i.test(line)) return json(res, 400, { error: "nothing to run" });

      // A model turn runs in the background (202); the page follows it on the event stream.
      const isTurn = (!line.startsWith("/") && !line.startsWith("!")) || /^\/plan\s+(?!off\s*$)\S/i.test(line);
      if (url.pathname === "/api/prompt" && !isTurn && (body.images !== undefined || body.documents !== undefined)) {
        return json(res, 400, { error: "files go with a message, not a command" });
      }
      if (url.pathname === "/api/prompt" && isTurn) {
        const images = pastedImages(body.images);
        const pasted = pastedDocuments(body.documents);
        // Reading PDFs and Word files takes a moment: meanwhile other messages get a 409, and Stop ends the read.
        const reading = new AbortController();
        preparing = reading;
        let documents;
        try {
          documents = await attachedTexts(pasted, reading.signal);
        } catch (error) {
          if (reading.signal.aborted) return json(res, 409, { error: "stopped" });
          throw error;
        } finally {
          preparing = undefined;
        }
        if (reading.signal.aborted) return json(res, 409, { error: "stopped" });
        if (busy) return json(res, 409, { error: "a turn is running; wait or stop it" });
        void run(line, images, documents);
        return json(res, 202, { ok: true, started: true });
      }
      const result = await run(line);
      return json(res, 200, { ok: Boolean(result), output: result?.output ?? "", state: await snapshot() });
    } catch (error) {
      if (error instanceof BadRequest) return json(res, 400, { error: error.message });
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/#${token}`,
    port,
    token,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        turnAbort?.abort();
        preparing?.abort();
        closeState(state);
        for (const client of clients) client.end();
        clients.clear();
        server.close(() => resolve());
      }),
  };
}
