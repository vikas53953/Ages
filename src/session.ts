import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  at: string;
};

export type SessionMeta = {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
};

export function harnessRoot(cwd: string) {
  return path.join(cwd, ".harness");
}

export function sessionDir(cwd: string, id: string) {
  return path.join(harnessRoot(cwd), "sessions", id);
}

async function writeJson(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function createSession(cwd: string, id?: string): Promise<SessionMeta> {
  const sessionId = id ?? new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const dir = sessionDir(cwd, sessionId);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: SessionMeta = { id: sessionId, createdAt: now, updatedAt: now, cwd };
  await writeJson(path.join(dir, "meta.json"), meta);
  await writeFile(path.join(dir, "messages.jsonl"), "", "utf8");
  await writeFile(path.join(harnessRoot(cwd), "current"), sessionId, "utf8");
  return meta;
}

export async function currentSessionId(cwd: string) {
  try {
    return (await readFile(path.join(harnessRoot(cwd), "current"), "utf8")).trim();
  } catch {
    return "";
  }
}

export async function loadOrCreateSession(cwd: string) {
  const id = await currentSessionId(cwd);
  if (id) {
    try {
      const raw = await readFile(path.join(sessionDir(cwd, id), "meta.json"), "utf8");
      return JSON.parse(raw) as SessionMeta;
    } catch {
      // fall through
    }
  }
  return createSession(cwd);
}

export async function listSessions(cwd: string) {
  const root = path.join(harnessRoot(cwd), "sessions");
  try {
    const names = await readdir(root);
    return names.sort().reverse();
  } catch {
    return [];
  }
}

export async function loadMessages(cwd: string, id: string): Promise<ChatMessage[]> {
  try {
    const raw = await readFile(path.join(sessionDir(cwd, id), "messages.jsonl"), "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatMessage);
  } catch {
    return [];
  }
}

export async function appendMessage(cwd: string, id: string, message: ChatMessage) {
  const dir = sessionDir(cwd, id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "messages.jsonl");
  const prev = await loadMessages(cwd, id);
  prev.push(message);
  await writeFile(file, prev.map((row) => JSON.stringify(row)).join("\n") + (prev.length ? "\n" : ""), "utf8");
  try {
    const metaRaw = await readFile(path.join(dir, "meta.json"), "utf8");
    const meta = JSON.parse(metaRaw) as SessionMeta;
    meta.updatedAt = message.at;
    await writeJson(path.join(dir, "meta.json"), meta);
  } catch {
    // new session files may race; ignore
  }
}

export async function replaceMessages(cwd: string, id: string, messages: ChatMessage[]) {
  const dir = sessionDir(cwd, id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "messages.jsonl");
  await writeFile(
    file,
    messages.map((row) => JSON.stringify(row)).join("\n") + (messages.length ? "\n" : ""),
    "utf8",
  );
}

export async function switchSession(cwd: string, id: string) {
  const meta = await readFile(path.join(sessionDir(cwd, id), "meta.json"), "utf8");
  JSON.parse(meta);
  await writeFile(path.join(harnessRoot(cwd), "current"), id, "utf8");
  return id;
}
