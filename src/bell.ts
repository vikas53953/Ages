/**
 * The terminal bell when Aegis needs you: a question is waiting (y/a/N), or a long turn has ended. Windows
 * Terminal flashes the tab and plays the system sound, so you can work in another window meanwhile.
 * Saved for you in ~/.aegis/settings.json ("bell": all | ask | done | off), like the theme.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userAegisDir } from "./env.ts";

export type BellMode = "all" | "ask" | "done" | "off";
export const BELL_MODES: BellMode[] = ["all", "ask", "done", "off"];
/** A turn shorter than this does not ring when it ends: you were probably watching. */
export const BELL_AFTER_MS = 5_000;

function file() {
  return path.join(userAegisDir(), "settings.json");
}

function readAll(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadBell(): BellMode {
  const value = readAll().bell;
  return BELL_MODES.includes(value as BellMode) ? (value as BellMode) : "all";
}

export function saveBell(mode: BellMode) {
  const settings = readAll();
  settings.bell = mode;
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/** Should this moment ring? `ask` = a question is waiting; `done` = a turn of `elapsedMs` ended. */
export function shouldRing(mode: BellMode, moment: "ask" | "done", elapsedMs = 0) {
  if (mode === "off") return false;
  if (moment === "ask") return mode === "all" || mode === "ask";
  return (mode === "all" || mode === "done") && elapsedMs >= BELL_AFTER_MS;
}

/** /bell, /bell off|ask|done|all */
export function bellCommand(arg: string | undefined) {
  const choice = arg?.trim().toLowerCase();
  if (!choice) {
    return `Bell: ${loadBell()}. /bell all rings when a question waits and when a turn over ${BELL_AFTER_MS / 1000} s ends; ask or done for one of them; off for none.`;
  }
  if (!BELL_MODES.includes(choice as BellMode)) return "usage: /bell all|ask|done|off";
  saveBell(choice as BellMode);
  return `Bell: ${choice} (saved for you, every folder).`;
}
