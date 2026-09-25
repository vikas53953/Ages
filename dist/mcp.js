/**
 * MCP (Model Context Protocol) tools behind the lock. Servers listed under "mcp" in ~/.aegis/settings.json
 * (yours, trusted) or .aegis/settings.json (the project's: started only after /mcp trust <name>, because a
 * cloned repo must not run programs on your PC just by being opened). Each server tool becomes
 * `mcp__<server>__<tool>` and passes the same gate as every other tool: deny/ask/allow rules, Jev, you.
 *
 * A small stdio client (JSON-RPC, one message per line): initialize → tools/list → tools/call.
 */
import { spawn } from "node:child_process";
import { killProcessTree, ownGroup, releaseGroup } from "./exec.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userAegisDir } from "./env.js";
import { redactSecrets } from "./redact.js";
import { settingsPath } from "./rules.js";
import { NO_CWD_SEARCH_ENV, programPath } from "./which.js";
const PROTOCOL = "2025-06-18";
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RESULT = 20_000;
function readJson(file) {
    try {
        const value = JSON.parse(readFileSync(file, "utf8"));
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    catch {
        return {};
    }
}
const strings = (value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string"))
    : undefined;
function serversIn(file) {
    const mcp = readJson(file).mcp;
    const out = {};
    for (const [name, server] of Object.entries(mcp?.servers ?? {})) {
        if (!NAME.test(name) || !server || typeof server !== "object")
            continue;
        if (typeof server.url === "string" && server.url) {
            out[name] = { url: server.url, headers: strings(server.headers) };
            continue;
        }
        if (typeof server.command !== "string" || !server.command)
            continue;
        const args = Array.isArray(server.args) ? server.args.filter((arg) => typeof arg === "string") : [];
        out[name] = { command: server.command, args, env: strings(server.env), cwd: typeof server.cwd === "string" ? server.cwd : undefined };
    }
    return out;
}
function trustFile() {
    return path.join(userAegisDir(), "mcp-trust.json");
}
/** A project server is trusted for this exact folder and exact command line only; change either and it asks again. */
function trustKey(cwd, name, server) {
    const hash = createHash("sha256")
        .update(JSON.stringify(server.url
        ? [path.resolve(cwd), name, "url", server.url, server.headers ?? {}]
        : [path.resolve(cwd), name, server.command, server.args ?? [], server.env ?? {}, server.cwd ?? ""]))
        .digest("hex");
    return hash.slice(0, 32);
}
export function trustProjectServer(cwd, name) {
    const server = serversIn(settingsPath(cwd))[name];
    if (!server)
        return false;
    const trusted = readJson(trustFile());
    trusted[trustKey(cwd, name, server)] = `${path.resolve(cwd)} ${name}`;
    mkdirSync(path.dirname(trustFile()), { recursive: true });
    writeFileSync(trustFile(), `${JSON.stringify(trusted, null, 2)}\n`);
    return true;
}
/** Your servers, then the project's (a project server with the same name as yours is ignored). */
export function mcpServers(cwd) {
    const user = serversIn(path.join(userAegisDir(), "settings.json"));
    const project = serversIn(settingsPath(cwd));
    const trusted = readJson(trustFile());
    const entries = Object.entries(user).map(([name, server]) => ({ ...server, name, scope: "user", trusted: true }));
    for (const [name, server] of Object.entries(project)) {
        if (user[name])
            continue;
        entries.push({ ...server, name, scope: "project", trusted: Boolean(trusted[trustKey(cwd, name, server)]) });
    }
    return entries;
}
/** The MCP protocol on top of a transport: initialize, list the tools, call one. */
export class McpClient {
    name;
    closed = false;
    constructor(name) {
        this.name = name;
    }
    async start() {
        await this.request("initialize", {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: { name: "aegis", version: "0.2" },
        }, 30_000);
        this.notify("notifications/initialized");
    }
    async listTools() {
        const tools = [];
        let cursor;
        do {
            const page = (await this.request("tools/list", cursor ? { cursor } : {}));
            for (const tool of page.tools ?? []) {
                if (!tool.name || !NAME.test(tool.name))
                    continue;
                // Providers reject tool names over 64 characters and non-object schemas, which would fail every turn.
                if (`mcp__${this.name}__${tool.name}`.length > 64)
                    continue;
                if (tool.inputSchema && tool.inputSchema.type !== undefined && tool.inputSchema.type !== "object")
                    continue;
                tools.push({
                    name: `mcp__${this.name}__${tool.name}`,
                    server: this.name,
                    tool: tool.name,
                    description: `[${this.name} MCP] ${tool.description ?? tool.name}`.slice(0, 1000),
                    inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" },
                });
            }
            cursor = page.nextCursor;
        } while (cursor && tools.length < 500);
        return tools;
    }
    async callTool(tool, args, signal) {
        const result = (await this.request("tools/call", { name: tool, arguments: args }, 300_000, signal));
        const parts = (result.content ?? []).map((part) => part.type === "text" ? String(part.text ?? "") : `[${part.type ?? "content"}${part.mimeType ? ` ${part.mimeType}` : ""} not shown]`);
        if (!parts.length && result.structuredContent !== undefined)
            parts.push(JSON.stringify(result.structuredContent));
        let text = parts.join("\n") || "(no output)";
        if (text.length > MAX_RESULT)
            text = `${text.slice(0, MAX_RESULT)}\n[… ${text.length - MAX_RESULT} more characters]`;
        return result.isError ? `MCP tool error: ${text}` : text;
    }
}
/** One running stdio MCP server. */
export class McpConnection extends McpClient {
    child;
    nextId = 1;
    pending = new Map();
    buffer = "";
    stderr = "";
    constructor(name, server, cwd) {
        super(name);
        // npx and many servers are .cmd files on Windows, which only start through cmd.exe; arguments come from your settings.
        // Resolved on PATH by full path, never from the project folder (see which.ts).
        const command = programPath(server.command ?? "");
        const windowsShim = process.platform === "win32" && !/\.(exe|com)$/i.test(command);
        const quote = (value) => (windowsShim ? `"${value.replace(/"/g, '""')}"` : value);
        this.child = spawn(windowsShim ? quote(command) : command, (server.args ?? []).map(quote), {
            cwd: server.cwd ? path.resolve(cwd, server.cwd) : cwd,
            env: { ...process.env, ...server.env, ...(windowsShim ? NO_CWD_SEARCH_ENV : {}) },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell: windowsShim,
            // POSIX: its own process group, so closing it also stops what it started (npx → node server).
            detached: process.platform !== "win32",
        });
        ownGroup(this.child.pid);
        this.child.on("close", () => releaseGroup(this.child.pid));
        this.child.stdout.setEncoding("utf8");
        this.child.stdout.on("data", (chunk) => this.onData(chunk));
        this.child.stderr.setEncoding("utf8");
        this.child.stderr.on("data", (chunk) => (this.stderr = (this.stderr + chunk).slice(-2000)));
        const fail = (why) => {
            this.closed = true;
            for (const entry of this.pending.values()) {
                clearTimeout(entry.timer);
                entry.reject(new Error(`MCP server ${name} ${why}${this.stderr ? `: ${this.stderr.trim().split("\n").at(-1)}` : ""}`));
            }
            this.pending.clear();
        };
        this.child.on("error", (error) => fail(`could not start (${error.message})`));
        // "close", not "exit": a server may answer and then exit, and its last answer is still in the pipe.
        this.child.on("close", (code) => fail(`exited (${code ?? "signal"})`));
    }
    onData(chunk) {
        this.buffer += chunk;
        if (this.buffer.length > 10_000_000)
            this.buffer = this.buffer.slice(-1_000_000);
        let at;
        while ((at = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, at).trim();
            this.buffer = this.buffer.slice(at + 1);
            if (!line)
                continue;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
                continue; // servers sometimes log to stdout
            }
            if (message.method && message.id !== undefined) {
                // A request from the server (sampling, roots…): not supported; say so instead of leaving it waiting.
                this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported by Aegis" } });
                continue;
            }
            const entry = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
            if (!entry)
                continue;
            this.pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error)
                entry.reject(new Error(message.error.message ?? "MCP error"));
            else
                entry.resolve(message.result);
        }
    }
    notify(method, params) {
        this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    }
    send(message) {
        if (!this.closed)
            this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    request(method, params, timeoutMs = 60_000, signal) {
        if (this.closed)
            return Promise.reject(new Error(`MCP server ${this.name} is not running`));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP server ${this.name}: ${method} timed out`));
            }, timeoutMs);
            const onAbort = () => {
                if (!this.pending.delete(id))
                    return;
                clearTimeout(timer);
                this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "stopped" } });
                reject(new Error("cancelled"));
            };
            const done = (settle) => {
                signal?.removeEventListener("abort", onAbort);
                settle();
            };
            this.pending.set(id, {
                resolve: (value) => done(() => resolve(value)),
                reject: (error) => done(() => reject(error)),
                timer,
            });
            signal?.addEventListener("abort", onAbort, { once: true });
            this.send({ jsonrpc: "2.0", id, method, params });
        });
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.child.stdin.end();
        }
        catch {
            // gone
        }
        // The whole tree: on Windows the server often runs under a cmd.exe wrapper (npx, uvx).
        if (this.child.pid)
            killProcessTree(this.child.pid);
    }
}
/** Bytes read from one HTTP answer at most (a tool result is capped far below this anyway). */
const MAX_HTTP_BODY = 10_000_000;
/** Is this a server Aegis may talk to? https anywhere; plain http only on this PC. */
export function mcpUrlProblem(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return "is not a valid URL";
    }
    if (url.username || url.password)
        return "has a user name or password in it; put a token in headers instead";
    if (url.protocol === "https:")
        return undefined;
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol === "http:" && local)
        return undefined;
    return "must use https (plain http only for localhost)";
}
/** ${NAME} in a header value → that environment variable (your own servers only; a project's are sent as written). */
function expandHeaders(serverName, headers, expand) {
    const out = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
        const text = expand
            ? value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
                const found = process.env[name];
                if (found === undefined || found === "")
                    throw new Error(`MCP server ${serverName}: header ${key} needs \${${name}}, which is not set`);
                return found;
            })
            : value;
        // Checked here, so the error names the header and never repeats its value (a token) the way fetch would.
        if (/[\r\n\0]/.test(text))
            throw new Error(`MCP server ${serverName}: header ${key} has a line break or NUL in it`);
        out[key] = text;
    }
    return out;
}
/**
 * One MCP server over HTTP (MCP's "streamable HTTP"): each request is a POST; the answer is JSON or an event
 * stream carrying it. Redirects are refused (your token must not follow one to another site), answers are
 * capped, and the session id the server gives is sent back on every later request.
 */
export class McpHttpConnection extends McpClient {
    nextId = 1;
    session;
    protocol;
    url;
    headers;
    aborts = new Set();
    constructor(name, server, expandEnv) {
        super(name);
        const problem = mcpUrlProblem(server.url ?? "");
        if (problem)
            throw new Error(`MCP server ${name}: the url ${problem}`);
        this.url = server.url;
        this.headers = expandHeaders(name, server.headers, expandEnv);
    }
    post(body, signal) {
        return fetch(this.url, {
            method: "POST",
            headers: {
                ...this.headers,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                ...(this.session ? { "mcp-session-id": this.session } : {}),
                ...(this.protocol ? { "mcp-protocol-version": this.protocol } : {}),
            },
            body: JSON.stringify(body),
            redirect: "error",
            signal,
        });
    }
    async request(method, params, timeoutMs = 60_000, signal) {
        if (this.closed)
            throw new Error(`MCP server ${this.name} is not running`);
        const id = this.nextId++;
        const abort = new AbortController();
        this.aborts.add(abort);
        const timer = setTimeout(() => abort.abort(new Error(`MCP server ${this.name}: ${method} timed out`)), timeoutMs);
        const onAbort = () => abort.abort(new Error("cancelled"));
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            const response = await this.post({ jsonrpc: "2.0", id, method, params }, abort.signal);
            if (!response.ok) {
                await response.body?.cancel().catch(() => undefined);
                const expired = response.status === 404 && this.session && method !== "initialize";
                throw new Error(`MCP server ${this.name}: HTTP ${response.status} for ${method}${expired ? " (its session ended; /mcp restart starts a new one)" : ""}`);
            }
            if (method === "initialize")
                this.session = response.headers.get("mcp-session-id") ?? undefined;
            const message = await this.answer(response, id);
            if (message.error)
                throw new Error(message.error.message ?? "MCP error");
            if (method === "initialize") {
                const version = message.result?.protocolVersion;
                this.protocol = typeof version === "string" ? version : PROTOCOL;
            }
            return message.result;
        }
        catch (error) {
            if (abort.signal.aborted && abort.signal.reason instanceof Error)
                throw abort.signal.reason;
            throw error;
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            this.aborts.delete(abort);
            if (signal?.aborted && !this.closed)
                this.notify("notifications/cancelled", { requestId: id, reason: "stopped" });
        }
    }
    /** The JSON-RPC answer with this id, from a JSON body or an event stream; at most MAX_HTTP_BODY bytes read. */
    async answer(response, id) {
        const type = response.headers.get("content-type") ?? "";
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error(`MCP server ${this.name}: empty answer`);
        const decoder = new TextDecoder();
        let text = "";
        let bytes = 0;
        const pick = (value) => {
            const list = Array.isArray(value) ? value : [value];
            // An answer, not a request from the server that happens to use the same id.
            return list.find((item) => item && typeof item === "object" && item.id === id && ("result" in item || "error" in item));
        };
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (value) {
                    bytes += value.length;
                    if (bytes > MAX_HTTP_BODY)
                        throw new Error(`MCP server ${this.name}: answer over ${MAX_HTTP_BODY / 1_000_000} MB`);
                    text += decoder.decode(value, { stream: true });
                }
                if (type.includes("text/event-stream")) {
                    // Events end with a blank line (the last one may end with the stream instead); each "data:" line of
                    // one event joins into one JSON message.
                    if (done)
                        text += "\n\n";
                    let end;
                    while ((end = text.search(/\r?\n\r?\n/)) >= 0) {
                        const event = text.slice(0, end);
                        text = text.slice(end).replace(/^\r?\n\r?\n/, "");
                        const data = event
                            .split(/\r?\n/)
                            .filter((line) => line.startsWith("data:"))
                            .map((line) => line.slice(5).replace(/^ /, ""))
                            .join("\n");
                        if (!data)
                            continue;
                        try {
                            const found = pick(JSON.parse(data));
                            if (found)
                                return found;
                        }
                        catch {
                            // not JSON: skip
                        }
                    }
                }
                if (done)
                    break;
            }
            if (!type.includes("text/event-stream")) {
                if (!text.trim())
                    throw new Error(`MCP server ${this.name}: empty answer to request ${id}`);
                const found = pick(JSON.parse(text));
                if (found)
                    return found;
            }
            throw new Error(`MCP server ${this.name}: no answer to request ${id}`);
        }
        finally {
            await reader.cancel().catch(() => undefined);
        }
    }
    notify(method, params) {
        if (this.closed)
            return;
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 10_000);
        void this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, abort.signal)
            .then((response) => response.body?.cancel())
            .catch(() => undefined)
            .finally(() => clearTimeout(timer));
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const abort of this.aborts)
            abort.abort(new Error(`MCP server ${this.name} closed`));
        // End the server's session, best effort.
        if (this.session) {
            void fetch(this.url, {
                method: "DELETE",
                headers: { ...this.headers, "mcp-session-id": this.session },
                redirect: "error",
                signal: AbortSignal.timeout(5_000),
            }).catch(() => undefined);
        }
    }
}
/** Start every trusted server and list its tools. A server that fails is reported, not fatal. */
export async function startMcp(cwd) {
    const state = { connections: [], tools: [], status: [] };
    for (const server of mcpServers(cwd)) {
        if (!server.trusted) {
            state.status.push({
                name: server.name,
                scope: server.scope,
                state: `not started: project server wants to run: ${describeServer(server)}\n${" ".repeat(26)}/mcp trust ${server.name} if you trust this repo`,
            });
            continue;
        }
        let connection;
        try {
            connection = server.url ? new McpHttpConnection(server.name, server, server.scope === "user") : new McpConnection(server.name, server, cwd);
            await connection.start();
            const tools = (await connection.listTools()).filter((tool) => !state.tools.some((known) => known.name === tool.name));
            state.connections.push(connection);
            state.tools.push(...tools);
            state.status.push({ name: server.name, scope: server.scope, state: `running, ${tools.length} tool(s)` });
        }
        catch (error) {
            connection?.close();
            // Cut anything secret-looking (a server or fetch may quote a header) before it is shown.
            const message = redactSecrets(error instanceof Error ? error.message : String(error)).text;
            state.status.push({ name: server.name, scope: server.scope, state: `failed: ${message}` });
        }
    }
    return state;
}
/** What a server would run, shown before you trust it. */
export function describeServer(server) {
    if (server.url) {
        const headers = Object.keys(server.headers ?? {});
        return [server.url, headers.length ? `(sends ${headers.join(", ")})` : ""].filter(Boolean).join(" ");
    }
    const env = Object.keys(server.env ?? {});
    return [
        [server.command, ...(server.args ?? [])].join(" "),
        server.cwd ? `(in ${server.cwd})` : "",
        env.length ? `(sets ${env.join(", ")})` : "",
    ]
        .filter(Boolean)
        .join(" ");
}
export function closeMcp(state) {
    for (const connection of state?.connections ?? [])
        connection.close();
}
