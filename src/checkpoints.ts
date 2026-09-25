/**
 * Restore points: before a write or edit you approved changes a file, Aegis keeps the file as it was.
 * /rewind puts files (and, if you want, the conversation) back to how they were before a chosen turn.
 * Like Cline and Gemini CLI. Shell commands are not tracked: what PowerShell changed stays changed.
 *
 * Kept in .harness/sessions/<id>/checkpoints/: index.jsonl (one line per saved file) and blobs/<seq>.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMessages, replaceMessages, sessionDir } from "./session.ts";

/** Files bigger than this are not kept (the rewind says so). */
export const MAX_CHECKPOINT_BYTES = 5_000_000;

export type Turn = { at: string; prompt: string };

type Entry = {
  seq: number;
  /** When the turn started (the user message's `at`), which names the turn. */
  turnAt: string;
  prompt: string;
  file: string;
  existed: boolean;
  tooLarge?: boolean;
};

function dir(cwd: string, sessionId: string) {
  return path.join(sessionDir(cwd, sessionId), "checkpoints");
}

async function readIndex(cwd: string, sessionId: string): Promise<Entry[]> {
  try {
    const text = await readFile(path.join(dir(cwd, sessionId), "index.jsonl"), "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Entry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function writeIndex(cwd: string, sessionId: string, entries: Entry[]) {
  await writeFile(path.join(dir(cwd, sessionId), "index.jsonl"), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

/** Keep `file` as it is now, once per turn (the first change in a turn is the one to undo to). */
export async function snapshotFile(cwd: string, sessionId: string, turn: Turn, file: string) {
  const absolute = path.resolve(cwd, file);
  const entries = await readIndex(cwd, sessionId);
  if (entries.some((entry) => entry.turnAt === turn.at && entry.file === absolute)) return;
  const base = dir(cwd, sessionId);
  await mkdir(path.join(base, "blobs"), { recursive: true });
  const seq = (entries.at(-1)?.seq ?? 0) + 1;
  const entry: Entry = { seq, turnAt: turn.at, prompt: turn.prompt.slice(0, 200), file: absolute, existed: existsSync(absolute) };
  if (entry.existed) {
    const info = await stat(absolute);
    if (info.size > MAX_CHECKPOINT_BYTES) entry.tooLarge = true;
    else await writeFile(path.join(base, "blobs", String(seq)), await readFile(absolute));
  }
  await appendFile(path.join(base, "index.jsonl"), `${JSON.stringify(entry)}\n`);
}

export type RewindPoint = { turnAt: string; prompt: string; files: string[] };

/** Turns that changed files, newest first. */
export async function rewindPoints(cwd: string, sessionId: string): Promise<RewindPoint[]> {
  const byTurn = new Map<string, RewindPoint>();
  for (const entry of await readIndex(cwd, sessionId)) {
    const point = byTurn.get(entry.turnAt) ?? { turnAt: entry.turnAt, prompt: entry.prompt, files: [] };
    if (!point.files.includes(entry.file)) point.files.push(entry.file);
    byTurn.set(entry.turnAt, point);
  }
  return [...byTurn.values()].sort((a, b) => b.turnAt.localeCompare(a.turnAt));
}

export type RewindResult = { restored: string[]; removed: string[]; skipped: string[]; messagesDropped: number };

/**
 * Put back every file changed in this turn and the turns after it, as it was before the turn began.
 * With `chat`, the conversation from that turn on is dropped too, so the model forgets it.
 */
export async function rewindTo(
  cwd: string,
  sessionId: string,
  turnAt: string,
  what: { files: boolean; chat: boolean },
): Promise<RewindResult> {
  const result: RewindResult = { restored: [], removed: [], skipped: [], messagesDropped: 0 };
  const entries = await readIndex(cwd, sessionId);
  const undone = entries.filter((entry) => entry.turnAt >= turnAt);
  if (what.files) {
    // The earliest keep of each file from this turn on is how it looked before the turn.
    const first = new Map<string, Entry>();
    for (const entry of undone) if (!first.has(entry.file)) first.set(entry.file, entry);
    for (const entry of first.values()) {
      if (entry.tooLarge) {
        result.skipped.push(entry.file);
        continue;
      }
      if (entry.existed) {
        const blob = await readFile(path.join(dir(cwd, sessionId), "blobs", String(entry.seq)));
        await mkdir(path.dirname(entry.file), { recursive: true });
        await writeFile(entry.file, blob);
        result.restored.push(entry.file);
      } else if (existsSync(entry.file)) {
        await unlink(entry.file);
        result.removed.push(entry.file);
      }
    }
    for (const entry of undone) await rm(path.join(dir(cwd, sessionId), "blobs", String(entry.seq)), { force: true });
    if (undone.length) await writeIndex(cwd, sessionId, entries.filter((entry) => entry.turnAt < turnAt));
  }
  if (what.chat) {
    const rows = await loadMessages(cwd, sessionId);
    const cut = rows.findIndex((row) => row.role === "user" && (row.at ?? "") >= turnAt);
    if (cut >= 0) {
      result.messagesDropped = rows.length - cut;
      await replaceMessages(cwd, sessionId, rows.slice(0, cut));
    }
    // Claude Code keeps its own conversation; start it fresh so it forgets the rewound turns too.
    await rm(path.join(sessionDir(cwd, sessionId), "claude-session"), { force: true });
  }
  return result;
}
