import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assertInsideCwd } from "../env.ts";

export async function readPath(relativePath: string, cwd: string) {
  const target = await assertInsideCwd(relativePath || ".", cwd);
  const info = await stat(target);
  if (info.isDirectory()) {
    const names = await readdir(target);
    return names.join("\n");
  }
  const body = await readFile(target, "utf8");
  if (body.length > 80_000) {
    return `${body.slice(0, 80_000)}\n\n[truncated ${body.length - 80_000} bytes]`;
  }
  return body;
}

export async function displayPath(relativePath: string, cwd: string) {
  const target = await assertInsideCwd(relativePath || ".", cwd);
  return path.relative(cwd, target) || ".";
}
