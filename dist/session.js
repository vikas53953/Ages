import { appendFile, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
/** Longest tool result kept in the session. The model saw the full text in its own turn. */
export const TOOL_RESULT_CAP = 8_000;
/** The readable text of a message: its text parts only. Tool calls and results are left out. */
export function messageText(message) {
    if (typeof message.content === "string")
        return message.content;
    return message.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("");
}
function capText(text, cap) {
    if (text.length <= cap)
        return text;
    return `${text.slice(0, cap)}\n[aegis: ${text.length - cap} more characters not kept in the session]`;
}
/** Shorten long tool results before they are saved, so one big read cannot flood every later turn. */
export function capToolResults(messages, cap = TOOL_RESULT_CAP) {
    return messages.map((message) => {
        if (message.role !== "tool" || typeof message.content === "string")
            return message;
        return {
            ...message,
            content: message.content.map((part) => {
                if (part.type !== "tool-result")
                    return part;
                const output = part.output;
                if (!output)
                    return part;
                if ((output.type === "text" || output.type === "error-text") && typeof output.value === "string") {
                    return { ...part, output: { ...output, value: capText(output.value, cap) } };
                }
                if (output.type === "json") {
                    const text = JSON.stringify(output.value);
                    if (text.length > cap)
                        return { ...part, output: { type: "text", value: capText(text, cap) } };
                }
                return part;
            }),
        };
    });
}
/**
 * Make history safe to send: every tool call needs its result and every result needs its call.
 * A turn cancelled halfway can leave one without the other, and providers reject that.
 */
export function repairHistory(messages) {
    const calls = new Set();
    const results = new Set();
    for (const message of messages) {
        if (typeof message.content === "string")
            continue;
        for (const part of message.content) {
            if (part.type === "tool-call")
                calls.add(String(part.toolCallId));
            if (part.type === "tool-result")
                results.add(String(part.toolCallId));
        }
    }
    const out = [];
    for (const message of messages) {
        if (typeof message.content === "string") {
            if (message.role === "tool")
                continue;
            if (message.content.trim() || message.role === "user")
                out.push(message);
            continue;
        }
        const parts = message.content.filter((part) => {
            if (part.type === "tool-call")
                return results.has(String(part.toolCallId));
            if (part.type === "tool-result")
                return calls.has(String(part.toolCallId));
            if (part.type === "text")
                return typeof part.text === "string" && part.text.length > 0;
            return true;
        });
        if (parts.length)
            out.push({ ...message, content: parts });
    }
    return out;
}
export function harnessRoot(cwd) {
    return path.join(cwd, ".harness");
}
export function sessionDir(cwd, id) {
    return path.join(harnessRoot(cwd), "sessions", id);
}
async function writeJson(file, value) {
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
export async function createSession(cwd, id) {
    const sessionId = id ?? new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
    const dir = sessionDir(cwd, sessionId);
    await mkdir(dir, { recursive: true });
    const now = new Date().toISOString();
    const meta = { id: sessionId, createdAt: now, updatedAt: now, cwd };
    await writeJson(path.join(dir, "meta.json"), meta);
    await writeFile(path.join(dir, "messages.jsonl"), "", "utf8");
    await writeFile(path.join(harnessRoot(cwd), "current"), sessionId, "utf8");
    return meta;
}
export async function currentSessionId(cwd) {
    try {
        return (await readFile(path.join(harnessRoot(cwd), "current"), "utf8")).trim();
    }
    catch {
        return "";
    }
}
export async function loadOrCreateSession(cwd) {
    const id = await currentSessionId(cwd);
    if (id) {
        try {
            const raw = await readFile(path.join(sessionDir(cwd, id), "meta.json"), "utf8");
            return JSON.parse(raw);
        }
        catch {
            // fall through
        }
    }
    return createSession(cwd);
}
export async function listSessions(cwd) {
    const root = path.join(harnessRoot(cwd), "sessions");
    try {
        const names = await readdir(root);
        return names.sort().reverse();
    }
    catch {
        return [];
    }
}
export async function loadMessages(cwd, id) {
    try {
        const raw = await readFile(path.join(sessionDir(cwd, id), "messages.jsonl"), "utf8");
        return raw
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    }
    catch {
        return [];
    }
}
export async function appendMessage(cwd, id, message) {
    const dir = sessionDir(cwd, id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "messages.jsonl");
    const prev = await loadMessages(cwd, id);
    prev.push(message);
    await writeFile(file, prev.map((row) => JSON.stringify(row)).join("\n") + (prev.length ? "\n" : ""), "utf8");
    try {
        const metaRaw = await readFile(path.join(dir, "meta.json"), "utf8");
        const meta = JSON.parse(metaRaw);
        meta.updatedAt = message.at;
        await writeJson(path.join(dir, "meta.json"), meta);
    }
    catch {
        // new session files may race; ignore
    }
}
/** Add several rows at once, e.g. everything one turn produced. */
export async function appendMessages(cwd, id, messages) {
    if (!messages.length)
        return;
    const dir = sessionDir(cwd, id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "messages.jsonl");
    await appendFile(file, messages.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
    try {
        const metaRaw = await readFile(path.join(dir, "meta.json"), "utf8");
        const meta = JSON.parse(metaRaw);
        meta.updatedAt = messages.at(-1).at;
        await writeJson(path.join(dir, "meta.json"), meta);
    }
    catch {
        // new session files may race; ignore
    }
}
export async function replaceMessages(cwd, id, messages) {
    const dir = sessionDir(cwd, id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "messages.jsonl");
    await writeFile(file, messages.map((row) => JSON.stringify(row)).join("\n") + (messages.length ? "\n" : ""), "utf8");
}
export async function switchSession(cwd, id) {
    const meta = await readFile(path.join(sessionDir(cwd, id), "meta.json"), "utf8");
    JSON.parse(meta);
    await writeFile(path.join(harnessRoot(cwd), "current"), id, "utf8");
    return id;
}
/** Newest sessions with their first prompt, for the welcome screen. Empty sessions are skipped. */
export async function recentSessions(cwd, limit = 3, skipId) {
    const out = [];
    for (const id of await listSessions(cwd)) {
        if (out.length >= limit)
            break;
        if (id === skipId)
            continue;
        const first = (await loadMessages(cwd, id)).find((row) => row.role === "user" && messageText(row).trim());
        if (!first)
            continue;
        const date = new Date(first.at);
        const when = Number.isNaN(date.getTime())
            ? id.slice(0, 10)
            : `${date.toISOString().slice(5, 10)} ${date.toTimeString().slice(0, 5)}`;
        out.push({ id, when, text: messageText(first).replace(/\s+/g, " ").trim() });
    }
    return out;
}
