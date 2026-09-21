import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assertInsideCwd } from "../env.ts";

const SKIP = new Set(["node_modules", ".git", ".gate", ".harness", "dist", "coverage"]);

function inside(root: string, candidate: string) {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function walk(dir: string, files: string[], root: string) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let real = full;
    try {
      real = await realpath(full);
    } catch {
      continue;
    }
    if (!inside(root, real)) continue;
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const info = await stat(real).catch(() => undefined);
      if (info?.isDirectory()) await walk(real, files, root);
      else if (info?.isFile()) files.push(real);
    } else if (entry.isFile()) {
      files.push(real);
    }
  }
}

export async function grepPath(pattern: string, relativePath: string, cwd: string) {
  const root = await assertInsideCwd(relativePath || ".", cwd);
  const info = await stat(root);
  const files: string[] = [];
  if (info.isDirectory()) {
    await walk(root, files, root);
  } else {
    files.push(root);
  }
  const regex = new RegExp(pattern, "i");
  const hits: string[] = [];
  for (const file of files) {
    if (hits.length >= 50) break;
    let body = "";
    try {
      body = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = body.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (hits.length >= 50) return;
      if (regex.test(line)) {
        hits.push(`${path.relative(cwd, file)}:${index + 1}:${line.trim()}`);
      }
    });
  }
  return hits.length ? hits.join("\n") : "no matches";
}
