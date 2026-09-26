import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assertInsideCwd } from "../env.ts";

/**
 * A folder's names, a whole file (cut at 80,000 characters), or with offset/limit a numbered slice of lines
 * (like Claude Code's Read), so a big file can be read piece by piece.
 */
export async function readPath(relativePath: string, cwd: string, lines?: { offset?: number; limit?: number }) {
  const target = await assertInsideCwd(relativePath || ".", cwd);
  const info = await stat(target);
  if (info.isDirectory()) {
    const names = await readdir(target, { withFileTypes: true });
    return names.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).join("\n");
  }
  const body = await readFile(target, "utf8");
  if (lines && (lines.offset !== undefined || lines.limit !== undefined)) {
    const all = body.split(/\r?\n/);
    const start = Math.max(1, Math.floor(lines.offset ?? 1));
    const count = Math.max(1, Math.min(2000, Math.floor(lines.limit ?? 2000)));
    const slice = all.slice(start - 1, start - 1 + count);
    const width = String(start + slice.length).length;
    const numbered = slice.map((text, index) => `${String(start + index).padStart(width)}  ${text}`).join("\n");
    const after = start - 1 + slice.length < all.length ? `\n[lines ${start}-${start + slice.length - 1} of ${all.length}]` : "";
    const text = numbered.length > 80_000 ? `${numbered.slice(0, 80_000)}\n[cut at 80,000 characters; ask for fewer lines]` : numbered;
    return (text || `[the file has ${all.length} lines]`) + after;
  }
  if (body.length > 80_000) {
    const total = body.split(/\r?\n/).length;
    return `${body.slice(0, 80_000)}\n\n[cut at 80,000 characters; the file has ${total} lines. Read more with offset and limit (line numbers).]`;
  }
  return body;
}

export async function displayPath(relativePath: string, cwd: string) {
  const target = await assertInsideCwd(relativePath || ".", cwd);
  return path.relative(cwd, target) || ".";
}
