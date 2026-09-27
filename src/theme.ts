import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userAegisDir } from "./env.ts";

/** Colour themes for the terminal face. A personal preference, so it lives in ~/.aegis, like Pi's theme setting. */
export type ThemeName = "aegis" | "light" | "contrast";
export type ThemeRole = "accent" | "strong" | "dim" | "ok" | "warn" | "err" | "italic";

export const THEMES: Record<ThemeName, Record<ThemeRole, string>> = {
  // Teal on a dark terminal: the default.
  aegis: { accent: "36", strong: "1;36", dim: "2", ok: "32", warn: "33", err: "31", italic: "3" },
  // Light backgrounds: cyan and yellow are unreadable on white, so blue, dark orange and grey instead of faint.
  light: { accent: "34", strong: "1;34", dim: "90", ok: "32", warn: "38;5;130", err: "31", italic: "3" },
  // Maximum contrast: bold bright colours and no faint text.
  contrast: { accent: "1;96", strong: "1;97", dim: "37", ok: "1;92", warn: "1;93", err: "1;91", italic: "37" },
};
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

let current: ThemeName = "aegis";

export function setTheme(name: ThemeName) {
  current = name;
}

export function themeName() {
  return current;
}

/** The escape that switches a role's colour on. */
export function on(role: ThemeRole) {
  return `\x1b[${THEMES[current][role]}m`;
}

export const OFF = "\x1b[0m";

export function paint(role: ThemeRole, text: string) {
  return `${on(role)}${text}${OFF}`;
}

export function parseTheme(text: string): ThemeName | undefined {
  const key = text.trim().toLowerCase();
  return THEME_NAMES.includes(key as ThemeName) ? (key as ThemeName) : undefined;
}

function userSettingsFile() {
  return path.join(userAegisDir(), "settings.json");
}

function readUserSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(userSettingsFile(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Read ~/.aegis/settings.json and apply its theme (unknown or missing: aegis). */
export function loadUserTheme() {
  const name = typeof readUserSettings().theme === "string" ? parseTheme(readUserSettings().theme as string) : undefined;
  setTheme(name ?? "aegis");
  return current;
}

export function saveUserTheme(name: ThemeName) {
  const settings = readUserSettings();
  // A file that exists but does not parse is left alone (rewriting it would drop your other settings).
  if (!Object.keys(settings).length && existsSync(userSettingsFile()) && readFileSync(userSettingsFile(), "utf8").trim()) {
    try {
      JSON.parse(readFileSync(userSettingsFile(), "utf8"));
    } catch {
      throw new Error(`${userSettingsFile()} is not valid JSON; fix it first, then /theme again`);
    }
  }
  settings.theme = name;
  mkdirSync(path.dirname(userSettingsFile()), { recursive: true });
  writeFileSync(userSettingsFile(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  setTheme(name);
}
