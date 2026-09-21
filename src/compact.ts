import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadMessages,
  replaceMessages,
  sessionDir,
  type ChatMessage,
} from "./session.ts";

const KEEP_DEFAULT = 4;

export function summarizeMessages(messages: ChatMessage[]) {
  return messages
    .map((message) => {
      const oneLine = message.content.replace(/\s+/g, " ").trim().slice(0, 160);
      return `- ${message.role}: ${oneLine}`;
    })
    .join("\n");
}

export async function compactSession(cwd: string, id: string, keepLast = KEEP_DEFAULT) {
  const messages = await loadMessages(cwd, id);
  if (messages.length <= keepLast) {
    return { summarized: 0, kept: messages.length, path: "" };
  }
  const old = messages.slice(0, -keepLast);
  const recent = messages.slice(-keepLast);
  const summary = summarizeMessages(old);
  const file = path.join(sessionDir(cwd, id), "summary.md");
  await writeFile(file, `${summary}\n`, "utf8");
  const stamp: ChatMessage = {
    role: "assistant",
    content: `[compacted ${old.length} messages]\n${summary}`,
    at: new Date().toISOString(),
  };
  await replaceMessages(cwd, id, [stamp, ...recent]);
  return { summarized: old.length, kept: recent.length + 1, path: file };
}
