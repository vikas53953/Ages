/**
 * The question Aegis asks before a tool runs, as a card (Claude Code's layout): what will happen in plain words,
 * the file or command in a frame, and the facts that matter (new file, 381 lines, 16 KB). The terminal draws it;
 * the lock's own details (rule, Jev score) become one quiet line saying why Aegis is asking.
 */
import path from "node:path";
import { editList, formatActionDiff } from "./gated.ts";
import type { JsonObject, ToolDecision } from "./types.ts";

export type ConfirmCard = {
  /** "Create file", "Run command". */
  title: string;
  /** The file, URL or agent the frame is about. */
  subject?: string;
  /** Everything to show in the frame (the collapsed card shows the first lines). */
  lines: string[];
  /** How to colour the lines: numbered code, a diff (+ / -), or plain text. */
  kind: "code" | "diff" | "text";
  /** "Create OpenAgentHackingPage.jsx?" */
  question: string;
  /** "new file · 381 lines · 16 KB" */
  facts?: string;
  /** Why Aegis is asking, in plain words. */
  reason: string;
};

/** Lines kept for the frame; more than this is cut, and the card says so. */
const CARD_MAX_LINES = 2_000;
const CARD_MAX_LINE = 400;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function size(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

function cap(lines: string[]) {
  const kept = lines.slice(0, CARD_MAX_LINES).map((line) => (line.length > CARD_MAX_LINE ? `${line.slice(0, CARD_MAX_LINE)}…` : line));
  if (lines.length > CARD_MAX_LINES) kept.push(`… ${lines.length - CARD_MAX_LINES} more lines not shown`);
  return kept;
}

/** A diff from formatActionDiff, without its "--- old / +++ new" header (the card says what it is). */
function diffLines(oldText: string, newText: string) {
  return formatActionDiff(oldText, newText)
    .split("\n")
    .filter((line) => !/^ {2}(---|\+\+\+) (old|new)$/.test(line))
    .map((line) => line.replace(/^ {2}/, ""));
}

const JEV_CLASS: Record<string, string> = {
  read_only: "read-only",
  reversible: "reversible",
  irreversible: "hard to undo",
  destructive: "destructive",
};

/** Why the lock is asking, from what decided it. */
function reasonFor(input: { rule?: { rule: string; action: string }; hook?: { reason: string }; decision?: ToolDecision; settingsError?: string }) {
  if (input.settingsError) return "Your settings file could not be read, so Aegis asks about every change.";
  if (input.hook) return `A hook asked for this: ${input.hook.reason}`;
  if (input.rule?.action === "ask") return `Your rule "${input.rule.rule}" says ask.`;
  const decision = input.decision;
  if (decision && decision.source !== "fail_closed") {
    return `Jev rates this ${JEV_CLASS[decision.class] ?? decision.class} (possible data loss ${Math.round(decision.dataLoss * 100)}%).`;
  }
  return "No rule allows this yet, so Aegis asks.";
}

export function confirmCard(input: {
  name: string;
  args: JsonObject;
  /** The file a write would replace (undefined: a new file). */
  existing?: string;
  decision?: ToolDecision;
  rule?: { rule: string; action: string };
  hook?: { reason: string };
  settingsError?: string;
}): ConfirmCard {
  const { name, args } = input;
  const reason = reasonFor(input);
  const file = String(args.path ?? "");
  const base = path.basename(file) || file;
  if (name === "write") {
    const contents = String(args.contents ?? "");
    const count = contents ? contents.replace(/\n$/, "").split("\n").length : 0;
    if (input.existing === undefined) {
      return {
        title: "Create file",
        subject: file,
        lines: cap(contents.replace(/\n$/, "").split("\n")),
        kind: "code",
        question: `Create ${base}?`,
        facts: `new file · ${plural(count, "line")} · ${size(Buffer.byteLength(contents))}`,
        reason,
      };
    }
    const before = input.existing.replace(/\n$/, "").split("\n").length;
    return {
      title: "Overwrite file",
      subject: file,
      lines: cap(diffLines(input.existing, contents)),
      kind: "diff",
      question: `Replace all of ${base}?`,
      facts: `the whole file is rewritten · ${before} → ${plural(count, "line")}`,
      reason,
    };
  }
  if (name === "edit") {
    if (args.edits !== undefined) {
      const edits = editList(args.edits);
      if (!edits) {
        return { title: "Edit file", subject: file, lines: ["(the changes could not be read; choose No)"], kind: "text", question: `Change ${base}?`, reason };
      }
      const lines = edits.flatMap((edit, index) => [
        `change ${index + 1} of ${edits.length}`,
        ...diffLines(String(edit.old_string ?? ""), String(edit.new_string ?? "")),
      ]);
      return {
        title: "Edit file",
        subject: file,
        lines: cap(lines),
        kind: "diff",
        question: `Make these ${edits.length} changes to ${base}?`,
        facts: "all or nothing",
        reason,
      };
    }
    return {
      title: "Edit file",
      subject: file,
      lines: cap(diffLines(String(args.old_string ?? ""), String(args.new_string ?? ""))),
      kind: "diff",
      question: `Make this change to ${base}?`,
      facts: args.replace_all ? "every match in the file" : undefined,
      reason,
    };
  }
  if (name === "shell") {
    return { title: "Run command", lines: cap(String(args.command ?? "").split("\n")), kind: "text", question: "Run this PowerShell command?", reason };
  }
  if (name === "webfetch") {
    const url = String(args.url ?? "");
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // shown as given
    }
    return { title: "Fetch web page", subject: url, lines: [], kind: "text", question: `Open ${host}?`, facts: "the page comes back as untrusted text", reason };
  }
  if (name === "websearch") {
    return { title: "Search the web", lines: [String(args.query ?? "")], kind: "text", question: "Send this search to Brave Search?", reason };
  }
  if (name === "agent") {
    // One line each: a task the model wrote cannot draw fake lines into the card.
    return {
      title: "Hand off to an agent",
      subject: String(args.name ?? ""),
      lines: cap([String(args.task ?? "").replace(/\s+/g, " ")]),
      kind: "text",
      question: `Let agent ${String(args.name ?? "")} do this?`,
      reason,
    };
  }
  if (name === "remember") {
    return { title: "Remember a note", lines: cap(String(args.note ?? args.text ?? "").split("\n")), kind: "text", question: "Keep this note for later sessions?", reason };
  }
  // Anything else (read, search, an MCP tool): its inputs, one per line.
  const lines = Object.entries(args).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return { title: `Use ${name}`, subject: file || undefined, lines: cap(lines.flatMap((line) => line.split("\n"))), kind: "text", question: `Allow ${name}${file ? ` on ${base}` : ""}?`, reason };
}
