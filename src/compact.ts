import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateText, type LanguageModel } from "ai";
import { languageModel } from "./providers.ts";
import {
  loadMessages,
  messageText,
  replaceMessages,
  sessionDir,
  type ChatMessage,
  type MessagePart,
} from "./session.ts";

/** Recent user turns kept word for word. Everything before them is folded into the summary. */
export const KEEP_TURNS_DEFAULT = 3;

/** Writes a summary of old turns. `previous` is the summary from an earlier compaction, if any. */
export type Summarizer = (input: {
  transcript: string;
  previous: string;
  abortSignal?: AbortSignal;
}) => Promise<string>;

export type CompactResult = {
  summarized: number;
  kept: number;
  method: "model" | "extract" | "none";
  path: string;
  error?: string;
};

/** Rough size of what gets sent to the model each turn. Characters, not tokens (about 4 chars per token). */
export function historySize(messages: ChatMessage[]) {
  return messages.reduce((total, message) => total + JSON.stringify(message.content).length, 0);
}

/** A real user turn starts with a user text message. */
function isTurnStart(message: ChatMessage) {
  return message.role === "user" && typeof message.content === "string";
}

/**
 * Split at the start of a user turn, so a tool call is never separated from its result.
 * Keeps the last `keepTurns` user turns; returns nothing to fold when there are not more turns than that.
 */
export function splitForCompaction(messages: ChatMessage[], keepTurns = KEEP_TURNS_DEFAULT) {
  const starts = messages.flatMap((message, index) => (isTurnStart(message) ? [index] : []));
  if (starts.length <= keepTurns) return { old: [] as ChatMessage[], recent: messages };
  const cut = starts[starts.length - keepTurns]!;
  return { old: messages.slice(0, cut), recent: messages.slice(cut) };
}

function oneLine(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function partLine(part: MessagePart) {
  if (part.type === "tool-call") {
    return `called ${String(part.toolName)} ${oneLine(JSON.stringify(part.input ?? {}), 200)}`;
  }
  if (part.type === "tool-result") {
    const output = part.output as { value?: unknown } | undefined;
    const value = typeof output?.value === "string" ? output.value : JSON.stringify(output?.value ?? "");
    return `${String(part.toolName)} returned: ${oneLine(value, 400)}`;
  }
  return "";
}

/** Old turns as plain lines for the summarizer: who said what, which tools ran, what they returned (shortened). */
export function transcriptOf(messages: ChatMessage[]) {
  const lines: string[] = [];
  for (const message of messages) {
    const text = messageText(message);
    if (text.trim()) lines.push(`${message.role}: ${oneLine(text, 2_000)}`);
    if (typeof message.content !== "string") {
      for (const part of message.content) {
        const line = partLine(part);
        if (line) lines.push(`  ${line}`);
      }
    }
  }
  return lines.join("\n");
}

/** No-model fallback: one short line per message, the previous summary kept on top. */
export function extractiveSummary(messages: ChatMessage[], previous = "") {
  const lines = messages
    .map((message) => {
      const text = oneLine(messageText(message), 160);
      if (text) return `- ${message.role}: ${text}`;
      if (typeof message.content !== "string") {
        const tools = message.content.map(partLine).filter(Boolean).map((line) => oneLine(line, 160));
        if (tools.length) return `- ${message.role}: ${tools.join("; ")}`;
      }
      return "";
    })
    .filter(Boolean);
  return [previous.trim(), ...lines].filter(Boolean).join("\n");
}

export const SUMMARY_SYSTEM = [
  "You compact the early part of a coding-agent session so the work can continue.",
  "Write at most 400 words of plain notes. Keep: the user's goals and constraints, decisions made,",
  "files read or changed and the key facts learned from them, commands run and their results,",
  "errors hit, and what is still open. Drop small talk. Do not invent anything.",
].join(" ");

/** Summarize with a chat model. The caller falls back to the extractive summary if this throws. */
export function modelSummarizer(model: string | LanguageModel): Summarizer {
  return async ({ transcript, previous, abortSignal }) => {
    const result = await generateText({
      model: typeof model === "string" ? languageModel(model) : model,
      system: SUMMARY_SYSTEM,
      prompt: [
        previous ? `Summary so far:\n${previous}\n` : "",
        `Conversation to fold in:\n${transcript}`,
        "\nWrite the updated summary.",
      ].join("\n"),
      maxOutputTokens: 900,
      abortSignal,
    });
    const text = result.text.trim();
    if (!text) throw new Error("empty summary");
    return text;
  };
}

export function summaryFile(cwd: string, id: string) {
  return path.join(sessionDir(cwd, id), "summary.md");
}

export async function loadSummary(cwd: string, id: string) {
  try {
    return (await readFile(summaryFile(cwd, id), "utf8")).trim();
  } catch {
    return "";
  }
}

/**
 * Fold old turns into summary.md and keep the recent turns as they were.
 * The summary reaches the model through the system prompt, not as a fake message.
 */
export async function compactSession(
  cwd: string,
  id: string,
  opts: { keepTurns?: number; summarize?: Summarizer; abortSignal?: AbortSignal } = {},
): Promise<CompactResult> {
  const messages = await loadMessages(cwd, id);
  const { old, recent } = splitForCompaction(messages, opts.keepTurns ?? KEEP_TURNS_DEFAULT);
  const file = summaryFile(cwd, id);
  if (!old.length) return { summarized: 0, kept: messages.length, method: "none", path: "" };
  const previous = await loadSummary(cwd, id);
  let summary = "";
  let method: CompactResult["method"] = "extract";
  let error: string | undefined;
  if (opts.summarize) {
    try {
      summary = await opts.summarize({ transcript: transcriptOf(old), previous, abortSignal: opts.abortSignal });
      method = "model";
    } catch (caught) {
      if (opts.abortSignal?.aborted) throw caught;
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  if (method !== "model") summary = extractiveSummary(old, previous);
  await writeFile(file, `${summary}\n`, "utf8");
  await replaceMessages(cwd, id, recent);
  return { summarized: old.length, kept: recent.length, method, path: file, error };
}

/** True when history is big enough that the next turn should compact first. */
export function needsCompaction(messages: ChatMessage[], limitChars: number) {
  return limitChars > 0 && historySize(messages) > limitChars;
}
