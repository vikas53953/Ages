/**
 * The terminal bell when Aegis needs you: a question is waiting (y/a/N), or a long turn has ended. Windows
 * Terminal flashes the tab and plays the system sound, so you can work in another window meanwhile.
 * Saved for you in ~/.aegis/settings.json ("bell": all | ask | done | off), like the theme.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userAegisDir } from "./env.js";
export const BELL_MODES = ["all", "ask", "done", "off"];
/** A turn shorter than this does not ring when it ends: you were probably watching. */
export const BELL_AFTER_MS = 5_000;
function file() {
    return path.join(userAegisDir(), "settings.json");
}
/** The file's settings; `broken` when it exists but is not a JSON object (then nothing is saved over it). */
function readAll() {
    let text;
    try {
        text = readFileSync(file(), "utf8");
    }
    catch {
        return { settings: {}, broken: false };
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            return { settings: parsed, broken: false };
    }
    catch {
        // fall through
    }
    return { settings: {}, broken: true };
}
export function loadBell() {
    const value = readAll().settings.bell;
    return BELL_MODES.includes(value) ? value : "all";
}
export function saveBell(mode) {
    const { settings, broken } = readAll();
    // Rewriting a file that does not parse would throw away everything else you keep in it.
    if (broken)
        throw new Error(`${file()} is not valid JSON; fix it first, then /bell again`);
    settings.bell = mode;
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
/** Should this moment ring? `ask` = a question is waiting; `done` = a turn of `elapsedMs` ended. */
export function shouldRing(mode, moment, elapsedMs = 0) {
    if (mode === "off")
        return false;
    if (moment === "ask")
        return mode === "all" || mode === "ask";
    return (mode === "all" || mode === "done") && elapsedMs >= BELL_AFTER_MS;
}
/** /bell, /bell off|ask|done|all */
export function bellCommand(arg) {
    const choice = arg?.trim().toLowerCase();
    if (!choice) {
        return `Bell: ${loadBell()}. /bell all rings when a question waits and when a turn over ${BELL_AFTER_MS / 1000} s ends; ask or done for one of them; off for none.`;
    }
    if (!BELL_MODES.includes(choice))
        return "usage: /bell all|ask|done|off";
    try {
        saveBell(choice);
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return `Bell: ${choice} (saved for you, every folder).`;
}
