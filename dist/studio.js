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
import { createServer } from "node:http";
import path from "node:path";
import { packageRoot } from "./env.js";
import { loadSettingsSafe, thinkingOf } from "./rules.js";
import { closeState, currentTodos, handleLine, modelChoices, startState, welcomeInfo, } from "./runtime.js";
import { loadMessages, messageText, recentSessions } from "./session.js";
import { turnStatusLines } from "./tui-layout.js";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN, sniffImage } from "./images.js";
/** 4 images of 5 MB as base64, plus the text. */
const PROMPT_BODY_LIMIT = Math.ceil((MAX_IMAGES_PER_TURN * MAX_IMAGE_BYTES * 4) / 3) + 1_000_000;
/**
 * Images pasted or dropped on the page: at most 4, each checked by its first bytes and size. Anything else is
 * refused with a 400, so a page bug cannot send the model a file it did not mean to.
 */
export function pastedImages(value) {
    if (value === undefined || value === null)
        return undefined;
    if (!Array.isArray(value))
        throw new BadRequest("images must be a list");
    if (value.length > MAX_IMAGES_PER_TURN)
        throw new BadRequest(`at most ${MAX_IMAGES_PER_TURN} images per message`);
    return value.map((item, index) => {
        const entry = (item ?? {});
        if (typeof entry.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data))
            throw new BadRequest("an image is not base64");
        const buf = Buffer.from(entry.data, "base64");
        if (buf.length > MAX_IMAGE_BYTES)
            throw new BadRequest("an image is over 5 MB");
        const mediaType = sniffImage(buf);
        if (!mediaType)
            throw new BadRequest("only PNG, JPEG, GIF and WebP images can be pasted");
        const name = typeof entry.name === "string" ? entry.name.replace(/[^\w.-]+/g, "_").slice(0, 60) : "";
        return { path: `pasted ${index + 1}${name ? ` (${name})` : ""}`, mediaType, bytes: buf.length, data: buf.toString("base64") };
    });
}
class BadRequest extends Error {
}
const STATIC = {
    "/": "index.html",
    "/app.js": "app.js",
    "/app.css": "app.css",
};
const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
};
/** Session rows → what the page shows: your prompts, the answers, and one line per tool call. */
export function displayMessages(rows) {
    const out = [];
    for (const row of rows) {
        if (row.role === "tool")
            continue;
        if (typeof row.content === "string") {
            if (row.content.trim())
                out.push({ role: row.role, text: row.content });
            continue;
        }
        for (const part of row.content) {
            if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
                out.push({ role: row.role, text: part.text });
            }
            else if (part.type === "tool-call") {
                const input = (part.input ?? {});
                const target = String(input.path ?? input.command ?? input.pattern ?? "");
                out.push({ role: "tool", text: `${String(part.toolName)} ${target}`.trim() });
            }
        }
    }
    if (!out.length) {
        for (const row of rows)
            if (messageText(row).trim())
                out.push({ role: row.role === "user" ? "user" : "assistant", text: messageText(row) });
    }
    return out;
}
export async function startStudio(input) {
    const token = randomBytes(18).toString("hex");
    const state = await startState(input.cwd, { ...input.opts, newSession: !input.continueSession });
    const clients = new Set();
    const pending = new Map();
    let nextApproval = 1;
    let busy = false;
    let turnAbort;
    const send = (event) => {
        const frame = `data: ${JSON.stringify(event)}\n\n`;
        for (const client of clients)
            if (!client.writableEnded && !client.destroyed)
                client.write(frame);
    };
    const confirm = (question, options) => new Promise((resolve) => {
        const id = nextApproval++;
        const finish = (answer) => {
            if (!pending.has(id))
                return;
            pending.delete(id);
            send({ kind: "approval_done", id, answer });
            resolve(answer);
        };
        pending.set(id, { resolve: finish, question, options });
        turnAbort?.signal.addEventListener("abort", () => finish(false), { once: true });
        send({ kind: "approval", id, question, options });
    });
    const run = async (text, images) => {
        busy = true;
        turnAbort = new AbortController();
        send({ kind: "started", text });
        try {
            const result = await handleLine(text, state, { ...input.opts, abortSignal: turnAbort.signal, images }, confirm, (event) => send({ kind: "event", event }));
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
        }
        catch (error) {
            send({ kind: "error", message: turnAbort.signal.aborted ? "stopped" : error instanceof Error ? error.message : String(error) });
            return undefined;
        }
        finally {
            for (const entry of pending.values())
                entry.resolve(false);
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
            busy,
            approvals: [...pending.entries()].map(([id, entry]) => ({ id, question: entry.question, options: entry.options })),
        };
    };
    const readBody = async (req, limit = 1_000_000) => {
        // Decode as one UTF-8 stream so a character split across chunks is not mangled.
        req.setEncoding("utf8");
        let body = "";
        for await (const chunk of req) {
            body += chunk;
            if (body.length > limit)
                throw new BadRequest("request too large");
        }
        if (!body)
            return {};
        try {
            const parsed = JSON.parse(body);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error();
            return parsed;
        }
        catch {
            throw new BadRequest("body must be a JSON object");
        }
    };
    const tokenOk = (given) => {
        if (typeof given !== "string" || given.length !== token.length)
            return false;
        return timingSafeEqual(Buffer.from(given), Buffer.from(token));
    };
    const json = (res, status, value) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(value));
    };
    const server = createServer(async (req, res) => {
        try {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            const host = (req.headers.host ?? "").toLowerCase();
            if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
                return json(res, 403, { error: "bad host" });
            const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
            res.setHeader("x-content-type-options", "nosniff");
            res.setHeader("referrer-policy", "no-referrer");
            if (req.method === "GET" && STATIC[url.pathname]) {
                const file = path.join(packageRoot(), "studio", STATIC[url.pathname]);
                const body = await readFile(file);
                res.writeHead(200, {
                    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
                    "cache-control": "no-store",
                    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
                });
                return res.end(body);
            }
            if (!url.pathname.startsWith("/api/"))
                return json(res, 404, { error: "not found" });
            // The key comes in a header; only the event stream (EventSource cannot set headers) may use ?t=.
            const given = req.headers["x-aegis-token"] ?? (url.pathname === "/api/events" ? url.searchParams.get("t") : null);
            if (!tokenOk(given))
                return json(res, 401, { error: "missing or wrong token" });
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
            if (req.method === "GET" && url.pathname === "/api/state")
                return json(res, 200, await snapshot());
            if (req.method === "GET" && url.pathname === "/api/models")
                return json(res, 200, modelChoices(state));
            if (req.method === "GET" && url.pathname === "/api/sessions") {
                return json(res, 200, { current: state.session.id, sessions: await recentSessions(state.cwd, 30) });
            }
            if (req.method === "GET" && url.pathname === "/api/messages") {
                return json(res, 200, displayMessages(await loadMessages(state.cwd, state.session.id)));
            }
            if (req.method !== "POST")
                return json(res, 405, { error: "method not allowed" });
            // Refused before the body is read: a busy server does not take in 28 MB of images only to say no.
            if (busy && url.pathname !== "/api/approve" && url.pathname !== "/api/stop") {
                return json(res, 409, { error: "a turn is running; wait or stop it" });
            }
            // A prompt may carry pasted images (4 × 5 MB, as base64); everything else stays small.
            const body = await readBody(req, url.pathname === "/api/prompt" ? PROMPT_BODY_LIMIT : undefined);
            if (url.pathname === "/api/approve") {
                const entry = pending.get(Number(body.id));
                if (!entry)
                    return json(res, 404, { error: "no such approval" });
                const answer = body.answer === "always" && entry.options?.always ? "always" : body.answer === "yes";
                entry.resolve(answer);
                return json(res, 200, { ok: true });
            }
            if (url.pathname === "/api/stop") {
                turnAbort?.abort();
                return json(res, 200, { ok: true });
            }
            if (busy)
                return json(res, 409, { error: "a turn is running; wait or stop it" });
            // Commands the page sends as buttons; they run exactly as if typed in the terminal.
            let line = "";
            if (url.pathname === "/api/prompt")
                line = String(body.text ?? "").trim();
            else if (url.pathname === "/api/model")
                line = `/model ${String(body.id ?? "").trim()}`;
            else if (url.pathname === "/api/think")
                line = `/think ${String(body.value ?? "").trim()}`;
            else if (url.pathname === "/api/new")
                line = "/new";
            else if (url.pathname === "/api/resume")
                line = `/resume ${String(body.id ?? "").trim()}`;
            else
                return json(res, 404, { error: "not found" });
            if (!line || /^\/(exit|quit|q)$/i.test(line))
                return json(res, 400, { error: "nothing to run" });
            // A model turn runs in the background (202); the page follows it on the event stream.
            const isTurn = (!line.startsWith("/") && !line.startsWith("!")) || /^\/plan\s+(?!off\s*$)\S/i.test(line);
            if (url.pathname === "/api/prompt" && !isTurn && body.images !== undefined) {
                return json(res, 400, { error: "images go with a message, not a command" });
            }
            if (url.pathname === "/api/prompt" && isTurn) {
                void run(line, pastedImages(body.images));
                return json(res, 202, { ok: true, started: true });
            }
            const result = await run(line);
            return json(res, 200, { ok: Boolean(result), output: result?.output ?? "", state: await snapshot() });
        }
        catch (error) {
            if (error instanceof BadRequest)
                return json(res, 400, { error: error.message });
            return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
    });
    await new Promise((resolve, reject) => {
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
        close: () => new Promise((resolve) => {
            turnAbort?.abort();
            closeState(state);
            for (const client of clients)
                client.end();
            clients.clear();
            server.close(() => resolve());
        }),
    };
}
