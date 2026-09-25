/**
 * MCP (Model Context Protocol) tools behind the lock. Servers listed under "mcp" in ~/.aegis/settings.json
 * (yours, trusted) or .aegis/settings.json (the project's: started only after /mcp trust <name>, because a
 * cloned repo must not run programs on your PC just by being opened). Each server tool becomes
 * `mcp__<server>__<tool>` and passes the same gate as every other tool: deny/ask/allow rules, Jev, you.
 *
 * A small stdio client (JSON-RPC, one message per line): initialize → tools/list → tools/call.
 */
import { spawn } from "node:child_process";
import { killProcessTree } from "./exec.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userAegisDir } from "./env.js";
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
function serversIn(file) {
    const mcp = readJson(file).mcp;
    const out = {};
    for (const [name, server] of Object.entries(mcp?.servers ?? {})) {
        if (!NAME.test(name) || !server || typeof server.command !== "string" || !server.command)
            continue;
        const args = Array.isArray(server.args) ? server.args.filter((arg) => typeof arg === "string") : [];
        const env = server.env && typeof server.env === "object" ? Object.fromEntries(Object.entries(server.env).filter(([, v]) => typeof v === "string")) : undefined;
        out[name] = { command: server.command, args, env, cwd: typeof server.cwd === "string" ? server.cwd : undefined };
    }
    return out;
}
function trustFile() {
    return path.join(userAegisDir(), "mcp-trust.json");
}
/** A project server is trusted for this exact folder and exact command line only; change either and it asks again. */
function trustKey(cwd, name, server) {
    const hash = createHash("sha256")
        .update(JSON.stringify([path.resolve(cwd), name, server.command, server.args ?? [], server.env ?? {}, server.cwd ?? ""]))
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
/** One running stdio MCP server. */
export class McpConnection {
    name;
    child;
    nextId = 1;
    pending = new Map();
    buffer = "";
    stderr = "";
    closed = false;
    constructor(name, server, cwd) {
        this.name = name;
        // npx and many servers are .cmd files on Windows, which only start through cmd.exe; arguments come from your settings.
        // Resolved on PATH by full path, never from the project folder (see which.ts).
        const command = programPath(server.command);
        const windowsShim = process.platform === "win32" && !/\.(exe|com)$/i.test(command);
        const quote = (value) => (windowsShim ? `"${value.replace(/"/g, '""')}"` : value);
        this.child = spawn(windowsShim ? quote(command) : command, (server.args ?? []).map(quote), {
            cwd: server.cwd ? path.resolve(cwd, server.cwd) : cwd,
            env: { ...process.env, ...server.env, ...(windowsShim ? NO_CWD_SEARCH_ENV : {}) },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell: windowsShim,
        });
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
    async start() {
        await this.request("initialize", {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: { name: "aegis", version: "0.2" },
        }, 30_000);
        this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
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
        const connection = new McpConnection(server.name, server, cwd);
        try {
            await connection.start();
            const tools = (await connection.listTools()).filter((tool) => !state.tools.some((known) => known.name === tool.name));
            state.connections.push(connection);
            state.tools.push(...tools);
            state.status.push({ name: server.name, scope: server.scope, state: `running, ${tools.length} tool(s)` });
        }
        catch (error) {
            connection.close();
            state.status.push({ name: server.name, scope: server.scope, state: `failed: ${error instanceof Error ? error.message : String(error)}` });
        }
    }
    return state;
}
/** What a server would run, shown before you trust it. */
export function describeServer(server) {
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
