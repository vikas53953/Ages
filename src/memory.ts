import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { harnessRoot } from "./session.ts";

export function memoryPath(cwd: string) {
  return path.join(harnessRoot(cwd), "memory.md");
}

export async function loadMemory(cwd: string) {
  try {
    return (await readFile(memoryPath(cwd), "utf8")).trim();
  } catch {
    return "";
  }
}

export async function addMemory(cwd: string, note: string) {
  const file = memoryPath(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  const line = `- ${new Date().toISOString().slice(0, 10)} ${note.trim()}\n`;
  await appendFile(file, line, "utf8");
  return line.trim();
}
