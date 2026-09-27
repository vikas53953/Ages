import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
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

/** The notes, one per line, as /memory numbers them. */
export async function memoryNotes(cwd: string) {
  return (await loadMemory(cwd)).split(/\r?\n/).filter((line) => line.trim());
}

/** Remove note n (1-based, as /memory shows it). Returns the removed line, or undefined when there is none. */
export async function removeMemory(cwd: string, n: number) {
  const notes = await memoryNotes(cwd);
  if (!Number.isInteger(n) || n < 1 || n > notes.length) return undefined;
  const [removed] = notes.splice(n - 1, 1);
  await writeFile(memoryPath(cwd), notes.length ? `${notes.join("\n")}\n` : "", "utf8");
  return removed;
}
