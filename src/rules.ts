import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type JevMode = "off" | "second-opinion" | "every-call";
export type RuleAction = "allow" | "ask" | "deny";

export const JEV_MODES: JevMode[] = ["off", "second-opinion", "every-call"];

export type Settings = {
  jev: { mode: JevMode };
  rules: Record<RuleAction, string[]>;
};

export type RuleMatch = { action: RuleAction; rule: string };

/**
 * Defaults when .aegis/settings.json is missing or leaves a list out.
 * Anything no rule matches is "grey zone": Jev decides if it is on, otherwise you are asked.
 */
export const DEFAULT_SETTINGS: Settings = {
  jev: { mode: "second-opinion" },
  rules: {
    deny: ["write .git/*", "edit .git/*", "write .harness/*", "edit .harness/*"],
    ask: [
      "shell Remove-Item*",
      "shell rm *",
      "shell del *",
      "shell rd *",
      "shell rmdir*",
      "shell git push*",
      "shell git reset --hard*",
      "shell git clean*",
      "shell format *",
      "shell netsh*",
      "shell Set-NetFirewall*",
      "shell Stop-Computer*",
      "shell Restart-Computer*",
    ],
    allow: ["read *", "grep *"],
  },
};

export function settingsPath(cwd: string) {
  return path.join(cwd, ".aegis", "settings.json");
}

function readRaw(cwd: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(settingsPath(cwd), "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath(cwd)} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function stringList(value: unknown, fallback: string[]) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("rules.allow / rules.ask / rules.deny must be lists of strings");
  }
  return value as string[];
}

/** A list in the file replaces the default list of the same name. A broken file throws: the caller fails safe. */
export function loadSettings(cwd: string): Settings {
  const raw = readRaw(cwd);
  if (!raw) return structuredClone(DEFAULT_SETTINGS);
  const jev = (raw.jev ?? {}) as { mode?: unknown };
  const mode = jev.mode ?? DEFAULT_SETTINGS.jev.mode;
  if (!JEV_MODES.includes(mode as JevMode)) {
    throw new Error(`jev.mode must be one of: ${JEV_MODES.join(", ")}`);
  }
  const rules = (raw.rules ?? {}) as Record<string, unknown>;
  return {
    jev: { mode: mode as JevMode },
    rules: {
      deny: stringList(rules.deny, DEFAULT_SETTINGS.rules.deny),
      ask: stringList(rules.ask, DEFAULT_SETTINGS.rules.ask),
      allow: stringList(rules.allow, DEFAULT_SETTINGS.rules.allow),
    },
  };
}

/** Settings that cannot be read fall back to Jev off and no allow rules: everything but a hard deny asks you. */
export function loadSettingsSafe(cwd: string): { settings: Settings; error?: string } {
  try {
    return { settings: loadSettings(cwd) };
  } catch (error) {
    return {
      settings: { jev: { mode: "off" }, rules: { ...DEFAULT_SETTINGS.rules, allow: [] } },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Change only jev.mode; keep everything else in the file. */
export function saveJevMode(cwd: string, mode: JevMode) {
  const raw = readRaw(cwd) ?? {};
  const jev = (raw.jev && typeof raw.jev === "object" ? raw.jev : {}) as Record<string, unknown>;
  raw.jev = { ...jev, mode };
  mkdirSync(path.dirname(settingsPath(cwd)), { recursive: true });
  writeFileSync(settingsPath(cwd), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

export function parseJevMode(text: string): JevMode | undefined {
  const key = text.trim().toLowerCase();
  if (key === "off") return "off";
  if (key === "second" || key === "second-opinion") return "second-opinion";
  if (key === "every" || key === "every-call") return "every-call";
  return undefined;
}

/** What a rule is matched against: the file path for read/write/edit/grep, the command for shell. */
export function ruleTarget(name: string, args: Record<string, unknown>) {
  if (name === "shell") return String(args.command ?? "").trim();
  const raw = String(args.path ?? ".").replaceAll("\\", "/");
  const clean = path.posix.normalize(raw).replace(/^\.\//, "");
  return clean || ".";
}

function globToRegex(glob: string) {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "is");
}

/** "shell git push*" → tool "shell", pattern "git push*". A bare "shell" matches every shell call. */
function splitRule(rule: string) {
  const text = rule.trim();
  const space = text.indexOf(" ");
  if (space < 0) return { tool: text.toLowerCase(), pattern: "*" };
  return { tool: text.slice(0, space).toLowerCase(), pattern: text.slice(space + 1).trim() };
}

/** Characters that chain or redirect PowerShell commands. */
const CHAIN = /[;&|`\n\r<>]|\$\(/;

function shellPieces(command: string) {
  return [command, ...command.split(/[;&|\n\r]+/).map((piece) => piece.trim()).filter(Boolean)];
}

function matches(rule: string, action: RuleAction, name: string, target: string) {
  const { tool, pattern } = splitRule(rule);
  if (tool !== name.toLowerCase()) return false;
  const regex = globToRegex(pattern);
  if (name !== "shell") return regex.test(target);
  // allow must cover the whole command, and never a chained one: "git status; Remove-Item x" is not "git status".
  if (action === "allow") return !CHAIN.test(target) && regex.test(target);
  // deny/ask catch the command anywhere in a chain.
  return shellPieces(target).some((piece) => regex.test(piece));
}

/** deny beats ask beats allow. Inside a list, the first rule that matches is reported. */
export function matchRule(
  settings: Settings,
  name: string,
  args: Record<string, unknown>,
): RuleMatch | undefined {
  const target = ruleTarget(name, args);
  for (const action of ["deny", "ask", "allow"] as const) {
    const rule = settings.rules[action].find((candidate) => matches(candidate, action, name, target));
    if (rule) return { action, rule };
  }
  return undefined;
}

export function isMutation(name: string) {
  return name === "write" || name === "edit" || name === "shell";
}
