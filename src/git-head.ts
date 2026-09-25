/**
 * The current git branch for the footer, read from .git/HEAD (like Pi's footer). No git program runs: a
 * repository's config cannot make this execute anything, and it costs one small file read.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The git folder for `cwd`: .git itself, or where a worktree's ".git" file points. Searched upward. */
function gitDir(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = path.join(dir, ".git");
    try {
      const info = statSync(candidate);
      if (info.isDirectory()) return candidate;
      if (info.isFile()) {
        const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, "utf8"))?.[1]?.trim();
        return target ? path.resolve(dir, target) : undefined;
      }
    } catch {
      // not here: look one folder up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** "main", "aegis/fix-login", a short commit id when detached, or undefined outside a repository. */
export function gitBranch(cwd: string): string | undefined {
  const dir = gitDir(cwd);
  if (!dir) return undefined;
  let head: string;
  try {
    head = readFileSync(path.join(dir, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  // Only the characters branch names use: a crafted HEAD must not put escape codes into your terminal.
  if (ref) return ref.replace(/[^\w./@+-]/g, "?").slice(0, 80);
  return /^[0-9a-f]{7,64}$/i.test(head) ? head.slice(0, 7) : undefined;
}

/** Cached for a moment: the footer repaints four times a second while a turn runs. */
export function cachedGitBranch(ms = 2_000) {
  let at = 0;
  let cwdSeen = "";
  let value: string | undefined;
  return (cwd: string) => {
    const now = Date.now();
    if (cwd !== cwdSeen || now - at > ms) {
      value = gitBranch(cwd);
      at = now;
      cwdSeen = cwd;
    }
    return value;
  };
}
