/**
 * Restore points: before a write or edit you approved changes a file, Aegis keeps the file as it was.
 * /rewind puts files (and, if you want, the conversation) back to how they were before a chosen turn.
 * Like Cline and Gemini CLI. Shell commands are not tracked: what PowerShell changed stays changed.
 *
 * Kept in .harness/sessions/<id>/checkpoints/: index.jsonl (one line per saved file, in order) and blobs/<seq>.
 * Only plain files inside the project are kept or restored: never through a symlink, never .git or .harness.
 */
import { existsSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
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

/** One index writer per session at a time: tools in one step run in parallel, and seq must stay unique. */
const queues = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
  queues.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

/**
 * The real path, even for something that does not exist yet: resolve the nearest folder that does exist,
 * then add the rest back. (On Windows a missing folder spelled short, RUNNER~1, must still match the long root.)
 */
export async function realOrSelf(target: string) {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** How a kept file is shown: relative to the project, whichever way its folder is spelled. */
export async function projectPath(cwd: string, file: string) {
  const relative = path.relative(await realOrSelf(cwd), file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

/**
 * The file as a safe restore target, or the reason it is not one: it must sit inside the project (after
 * following the folders above it), must not itself be a symlink, and must not be in .git or .harness.
 */
async function safeTarget(cwd: string, file: string): Promise<{ file: string } | { reason: string }> {
  // Compare real paths on both sides: on Windows the same folder can be spelled short (RUNNER~1) or long.
  const root = await realOrSelf(cwd);
  const absolute = path.resolve(cwd, file);
  const parent = await realOrSelf(path.dirname(absolute));
  const inside = path.relative(root, path.join(parent, path.basename(absolute)));
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return { reason: "outside the project" };
  if (/^(\.git|\.harness)([\\/]|$)/i.test(inside)) return { reason: "inside .git or .harness" };
  try {
    if ((await lstat(absolute)).isSymbolicLink()) return { reason: "it is a symlink" };
  } catch {
    // does not exist: fine
  }
  return { file: path.join(parent, path.basename(absolute)) };
}

/** Keep `file` as it is now, once per turn (the first change in a turn is the one to undo to). */
export function snapshotFile(cwd: string, sessionId: string, turn: Turn, file: string) {
  return serialize(`${path.resolve(cwd)}\0${sessionId}`, async () => {
    const target = await safeTarget(cwd, file);
    if ("reason" in target) return; // the tool refuses these too; nothing to keep
    const absolute = target.file;
    const entries = await readIndex(cwd, sessionId);
    if (entries.some((entry) => entry.turnAt === turn.at && entry.file === absolute)) return;
    const base = dir(cwd, sessionId);
    await mkdir(path.join(base, "blobs"), { recursive: true });
    const seq = Math.max(0, ...entries.map((entry) => entry.seq)) + 1;
    const entry: Entry = { seq, turnAt: turn.at, prompt: turn.prompt.slice(0, 200), file: absolute, existed: false };
    try {
      const info = await lstat(absolute);
      if (!info.isFile()) return; // a directory or device: the write will fail on its own
      entry.existed = true;
      if (info.size > MAX_CHECKPOINT_BYTES) entry.tooLarge = true;
      else await writeFile(path.join(base, "blobs", String(seq)), await readFile(absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    }
    await appendFile(path.join(base, "index.jsonl"), `${JSON.stringify(entry)}\n`);
  });
}

export type RewindPoint = { turnAt: string; prompt: string; files: string[] };

/** Turns that changed files, newest first (by the order they were kept, not the clock). */
export async function rewindPoints(cwd: string, sessionId: string): Promise<RewindPoint[]> {
  const byTurn = new Map<string, RewindPoint & { firstSeq: number }>();
  for (const entry of await readIndex(cwd, sessionId)) {
    const point = byTurn.get(entry.turnAt) ?? { turnAt: entry.turnAt, prompt: entry.prompt, files: [], firstSeq: entry.seq };
    if (!point.files.includes(entry.file)) point.files.push(entry.file);
    point.firstSeq = Math.min(point.firstSeq, entry.seq);
    byTurn.set(entry.turnAt, point);
  }
  return [...byTurn.values()].sort((a, b) => b.firstSeq - a.firstSeq).map(({ firstSeq: _, ...point }) => point);
}

export type RewindResult = {
  restored: string[];
  removed: string[];
  skipped: Array<{ file: string; reason: string }>;
  messagesDropped: number;
};

/**
 * Put back every file changed in this turn and the turns after it, as it was before the turn began.
 * With `chat`, the conversation from that turn on is dropped too, so the model forgets it.
 * One file that cannot be restored is reported and skipped; the rest still are.
 */
export async function rewindTo(
  cwd: string,
  sessionId: string,
  turnAt: string,
  what: { files: boolean; chat: boolean },
): Promise<RewindResult> {
  const result: RewindResult = { restored: [], removed: [], skipped: [], messagesDropped: 0 };
  if (what.files) {
    await serialize(`${path.resolve(cwd)}\0${sessionId}`, async () => {
      const entries = await readIndex(cwd, sessionId);
      const start = Math.min(...entries.filter((entry) => entry.turnAt === turnAt).map((entry) => entry.seq));
      if (!Number.isFinite(start)) return;
      const undone = entries.filter((entry) => entry.seq >= start);
      // The earliest keep of each file from this turn on is how it looked before the turn.
      const first = new Map<string, Entry>();
      for (const entry of [...undone].sort((a, b) => a.seq - b.seq)) if (!first.has(entry.file)) first.set(entry.file, entry);
      for (const entry of first.values()) {
        try {
          if (entry.tooLarge) throw new Error("too large to keep");
          const target = await safeTarget(cwd, entry.file);
          if ("reason" in target) throw new Error(target.reason);
          if (entry.existed) {
            const blob = await readFile(path.join(dir(cwd, sessionId), "blobs", String(entry.seq)));
            await mkdir(path.dirname(target.file), { recursive: true });
            await writeFile(target.file, blob);
            result.restored.push(target.file);
          } else if (existsSync(target.file)) {
            if (!(await lstat(target.file)).isFile()) throw new Error("it is no longer a file");
            await unlink(target.file);
            result.removed.push(target.file);
          }
        } catch (error) {
          result.skipped.push({ file: entry.file, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      for (const entry of undone) await rm(path.join(dir(cwd, sessionId), "blobs", String(entry.seq)), { force: true });
      await writeIndex(cwd, sessionId, entries.filter((entry) => entry.seq < start));
    });
  }
  if (what.chat) {
    const rows = await loadMessages(cwd, sessionId);
    let cut = rows.findIndex((row) => row.role === "user" && row.at === turnAt);
    if (cut < 0) cut = rows.findIndex((row) => row.role === "user" && (row.at ?? "") >= turnAt);
    if (cut >= 0) {
      result.messagesDropped = rows.length - cut;
      await replaceMessages(cwd, sessionId, rows.slice(0, cut));
    }
    // Claude Code keeps its own conversation; start it fresh so it forgets the rewound turns too.
    await rm(path.join(sessionDir(cwd, sessionId), "claude-session"), { force: true });
  }
  return result;
}

export type SessionChange = {
  /** Real path of the file. */
  file: string;
  /** How it was before this session first changed it: text, absent (the agent created it), or not kept. */
  before: { kind: "text"; text: string } | { kind: "absent" } | { kind: "not kept"; reason: string };
  /** How it is now. */
  now: { kind: "text"; text: string } | { kind: "absent" } | { kind: "not shown"; reason: string };
};

async function textOf(buf: Buffer): Promise<string | undefined> {
  return buf.includes(0) ? undefined : buf.toString("utf8");
}

/**
 * Every file an approved write or edit changed in this session, compared with how it was before the first such
 * change (from the restore points, so no program runs and it works outside git). Shell changes are not tracked.
 */
export async function sessionChanges(cwd: string, sessionId: string): Promise<SessionChange[]> {
  const first = new Map<string, Entry>();
  for (const entry of [...(await readIndex(cwd, sessionId))].sort((a, b) => a.seq - b.seq)) {
    if (!first.has(entry.file)) first.set(entry.file, entry);
  }
  const out: SessionChange[] = [];
  for (const entry of first.values()) {
    let before: SessionChange["before"];
    if (!entry.existed) before = { kind: "absent" };
    else if (entry.tooLarge) before = { kind: "not kept", reason: "too large to keep" };
    else {
      try {
        const text = await textOf(await readFile(path.join(dir(cwd, sessionId), "blobs", String(entry.seq))));
        before = text === undefined ? { kind: "not kept", reason: "binary file" } : { kind: "text", text };
      } catch {
        before = { kind: "not kept", reason: "restore point missing" };
      }
    }
    let now: SessionChange["now"];
    const target = await safeTarget(cwd, entry.file);
    if ("reason" in target) now = { kind: "not shown", reason: target.reason };
    else {
      try {
        const info = await lstat(target.file);
        if (!info.isFile()) now = { kind: "not shown", reason: "no longer a file" };
        else if (info.size > MAX_CHECKPOINT_BYTES) now = { kind: "not shown", reason: "too large to show" };
        else {
          const text = await textOf(await readFile(target.file));
          now = text === undefined ? { kind: "not shown", reason: "binary file" } : { kind: "text", text };
        }
      } catch {
        now = { kind: "absent" };
      }
    }
    out.push({ file: entry.file, before, now });
  }
  return out;
}
