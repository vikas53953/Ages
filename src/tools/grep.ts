import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assertInsideCwd } from "../env.ts";
import { isSecretFile } from "../rules.ts";

/** Never searched, whatever .gitignore says. */
const SKIP = new Set(["node_modules", ".git", ".gate", ".harness", "dist", "coverage"]);
const MAX_HITS = 100;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2_000_000;
/** One hit shows up to this much of its line (a minified file is one huge line), and all hits together this much. */
const MAX_LINE_CHARS = 300;
const MAX_RESULT_CHARS = 200_000;

/** A long line cut to the part around the match. */
function around(line: string, regex: RegExp) {
  if (line.length <= MAX_LINE_CHARS) return line;
  const at = Math.max(0, line.search(regex));
  const start = Math.max(0, at - 100);
  return `${start > 0 ? "…" : ""}${line.slice(start, start + MAX_LINE_CHARS)}…`;
}

function inside(root: string, candidate: string) {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** A glob's regex body ("*" stays in one folder, "**" crosses folders, "?" one character, {a,b} either). */
function globBody(glob: string) {
  let body = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        body += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else body += "[^/]*";
    } else if (ch === "?") body += "[^/]";
    else if (ch === "[" && glob.indexOf("]", i + 2) > i) {
      // [abc], [a-z], [!abc] as in git; inside, only "\\" and "]" need care.
      const end = glob.indexOf("]", i + 2);
      let inner = glob.slice(i + 1, end);
      const negate = inner.startsWith("!") || inner.startsWith("^");
      if (negate) inner = inner.slice(1);
      body += `[${negate ? "^/" : ""}${inner.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")}]`;
      i = end;
    }
    else if (ch === "{" && glob.indexOf("}", i) > i) {
      const end = glob.indexOf("}", i);
      body += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join("|")})`;
      i = end;
    } else body += ch.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  return body;
}

const FLAGS = process.platform === "win32" ? "i" : "";

/**
 * A glob ("src/**\/*.ts", "*.md") as a regex over "/"-separated relative paths. Without a "/" it matches the
 * name in any folder (like ripgrep's --glob and .gitignore); with one, from the top.
 */
export function globRegex(glob: string) {
  const clean = glob.replace(/^\.\//, "");
  return clean.includes("/") ? new RegExp(`^${globBody(clean.replace(/^\//, ""))}$`, FLAGS) : new RegExp(`(^|/)${globBody(clean)}$`, FLAGS);
}

type IgnoreRule = { base: string; negate: boolean; dirOnly: boolean; regex: RegExp };

/** One .gitignore's rules, simply: plain and glob patterns, "dir/" for folders, "!" re-includes. `base` = its folder. */
async function readIgnore(dir: string, base: string): Promise<IgnoreRule[]> {
  let text = "";
  try {
    text = await readFile(path.join(dir, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      let pattern = negate ? line.slice(1) : line;
      const dirOnly = pattern.endsWith("/");
      if (dirOnly) pattern = pattern.slice(0, -1);
      // A "/" at the start or in the middle ties the pattern to that .gitignore's folder (git's rule).
      const anchored = pattern.includes("/");
      pattern = pattern.replace(/^\//, "");
      const regex = anchored ? new RegExp(`^${globBody(pattern)}$`, FLAGS) : new RegExp(`(^|/)${globBody(pattern)}$`, FLAGS);
      return { base, negate, dirOnly, regex };
    });
}

/** Git's order: rules from the top folder first, deeper .gitignore files later (so they win); last match decides. */
function isIgnored(rules: IgnoreRule[], relative: string, isDir: boolean) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.base && !relative.startsWith(`${rule.base}/`)) continue;
    const local = rule.base ? relative.slice(rule.base.length + 1) : relative;
    if (rule.regex.test(local)) ignored = !rule.negate;
  }
  return ignored;
}

export type Walked = { file: string; relative: string };
export type WalkStats = { secretsSkipped: number };

/** Files under root (links followed only inside it), minus SKIP and .gitignore. */
export async function walkFiles(start: string, limit = 20_000, stats?: WalkStats): Promise<Walked[]> {
  // The real path: files are compared as real paths, and on Windows the start may be an 8.3 short spelling.
  const root = await realpath(start).catch(() => start);
  const out: Walked[] = [];
  // Real folders already walked: a link back to a parent (a repo can ship "self -> .") must not loop forever.
  const seenDirs = new Set<string>();
  const seenFiles = new Set<string>();
  const visit = async (dir: string, rel: string, inherited: IgnoreRule[]) => {
    if (out.length >= limit) return;
    const realDir = await realpath(dir).catch(() => dir);
    if (seenDirs.has(realDir)) return;
    seenDirs.add(realDir);
    // This folder's own .gitignore applies below it, after (and so over) its parents' rules.
    const rules = [...inherited, ...(await readIgnore(dir, rel))];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      let real = full;
      try {
        real = await realpath(full);
      } catch {
        continue;
      }
      if (!inside(root, real)) continue;
      const info = await stat(real).catch(() => undefined);
      if (!info) continue;
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (isIgnored(rules, relative, info.isDirectory())) continue;
      if (info.isDirectory()) await visit(real, relative, rules);
      else if (info.isFile() && !seenFiles.has(real)) {
        seenFiles.add(real);
        // Secrets files are not searched as part of a folder; naming one (grep x .env) is asked about instead.
        if (stats && isSecretFile(relative)) {
          stats.secretsSkipped += 1;
          continue;
        }
        out.push({ file: real, relative });
      }
    }
  };
  await visit(root, "", []);
  return out;
}

async function looksBinary(file: string) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export type GrepOptions = { glob?: string; caseSensitive?: boolean; context?: number };

export async function grepPath(pattern: string, relativePath: string, cwd: string, options: GrepOptions = {}) {
  const root = await assertInsideCwd(relativePath || ".", cwd);
  const info = await stat(root);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, options.caseSensitive ? "" : "i");
  } catch (error) {
    return `bad pattern: ${error instanceof Error ? error.message : String(error)}`;
  }
  const only = options.glob ? globRegex(options.glob) : undefined;
  const stats: WalkStats = { secretsSkipped: 0 };
  const files = info.isDirectory()
    ? (await walkFiles(root, 20_000, stats)).filter((entry) => !only || only.test(entry.relative)).map((entry) => entry.file)
    : [root];
  const context = Math.max(0, Math.min(5, Math.floor(options.context ?? 0)));
  // Show paths from the real folder: files are real paths, and on Windows cwd may be an 8.3 short spelling.
  const base = await realpath(cwd).catch(() => cwd);
  const hits: string[] = [];
  let total = 0;
  let size = 0;
  for (const file of files) {
    let body = "";
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES || (await looksBinary(file))) continue;
      body = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = body.split(/\r?\n/);
    const shown = path.relative(base, file).split(path.sep).join("/");
    lines.forEach((line, index) => {
      if (!regex.test(line)) return;
      total += 1;
      if (hits.length >= MAX_HITS) return;
      if (size >= MAX_RESULT_CHARS) return;
      let hit: string;
      if (!context) {
        hit = `${shown}:${index + 1}:${around(line.trim(), regex)}`;
      } else {
        const from = Math.max(0, index - context);
        const to = Math.min(lines.length, index + context + 1);
        hit =
          lines
            .slice(from, to)
            .map((text, offset) => `${shown}${from + offset === index ? ":" : "-"}${from + offset + 1}${from + offset === index ? ":" : "-"}${around(text, regex)}`)
            .join("\n") + "\n--";
      }
      size += hit.length;
      hits.push(hit);
    });
  }
  const skipped = stats.secretsSkipped
    ? `\n[${stats.secretsSkipped} secrets file(s) such as .env were not searched; grep one by name to be asked]`
    : "";
  if (!hits.length) return `no matches${skipped}`;
  const more =
    total > hits.length
      ? `\n[… ${total - hits.length} more matches not shown${size >= MAX_RESULT_CHARS ? " (output limit)" : ""}; narrow the pattern, path or glob]`
      : "";
  return hits.join("\n") + more + skipped;
}

/** File paths matching a glob, newest first (like Claude Code's Glob). */
export async function globPath(pattern: string, relativePath: string, cwd: string) {
  const root = await assertInsideCwd(relativePath || ".", cwd);
  const regex = globRegex(pattern);
  const matched = (await walkFiles(root)).filter((entry) => regex.test(entry.relative));
  const dated = await Promise.all(
    matched.map(async (entry) => ({ entry, time: (await stat(entry.file).catch(() => undefined))?.mtimeMs ?? 0 })),
  );
  dated.sort((a, b) => b.time - a.time);
  const base = await realpath(cwd).catch(() => cwd);
  const shown = dated.slice(0, MAX_FILES).map(({ entry }) => path.relative(base, entry.file).split(path.sep).join("/"));
  if (!shown.length) return "no files match";
  return shown.join("\n") + (dated.length > MAX_FILES ? `\n[… ${dated.length - MAX_FILES} more files not shown]` : "");
}
