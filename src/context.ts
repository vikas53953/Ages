import { readFile } from "node:fs/promises";
import path from "node:path";
import { userAegisDir } from "./env.ts";

/** Project files, in this order: the shared ones, then AGENTS.local.md (yours, for this folder; keep it out of git). */
const NAMES = ["AGENTS.md", "HARNESS.md", "AGENTS.local.md"];

async function section(file: string, title: string) {
  try {
    const body = (await readFile(file, "utf8")).trim();
    return body ? `## ${title}\n${body}` : "";
  } catch {
    return ""; // optional
  }
}

/**
 * Standing instructions for the model: yours for every project (~/.aegis/AGENTS.md, like ~/.codex/AGENTS.md and
 * ~/.claude/CLAUDE.md) first, then the project's. The project's come later, so they can be more specific.
 */
export async function loadContext(cwd: string) {
  const chunks = [await section(path.join(userAegisDir(), "AGENTS.md"), "Your AGENTS.md (every project)")];
  for (const name of NAMES) chunks.push(await section(path.join(cwd, name), name));
  return chunks.filter(Boolean).join("\n\n");
}

/** /init: one turn that looks around and writes (through the lock) a first AGENTS.md for this project. */
export const INIT_PROMPT = [
  "Create an AGENTS.md for this project (or improve the existing one), for coding agents that will work here later.",
  "First look around: read the README, the build/test configuration and the main folders (use explore for a broad look).",
  "Then write AGENTS.md with short sections: what the project is, how to build, test and run it (exact commands),",
  "the layout (key folders and files), conventions to follow, and anything risky to avoid. Keep it under 80 lines;",
  "facts only, nothing you did not see. If AGENTS.md exists, keep what is still right and edit it instead of replacing it.",
].join(" ");
