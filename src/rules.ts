import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_THINKING,
  DEFAULT_THINKING_DISPLAY,
  THINKING_DISPLAYS,
  THINKING_LEVELS,
  type ThinkingDisplay,
  type ThinkingLevel,
} from "./thinking.ts";

export type JevMode = "off" | "second-opinion" | "every-call";
export type RuleAction = "allow" | "ask" | "deny";

export const JEV_MODES: JevMode[] = ["off", "second-opinion", "every-call"];

export type Settings = {
  jev: { mode: JevMode };
  rules: Record<RuleAction, string[]>;
  /** Layer-1 plugins to load, in order. The core runs with none. */
  plugins: string[];
  /** How hard the model thinks, and how its reasoning is shown. Missing = defaults (low, folded). */
  thinking?: { level?: ThinkingLevel; display?: ThinkingDisplay };
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
  plugins: ["jev", "delivery", "receipts"],
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

function stringList(value: unknown, fallback: string[], name = "rules.allow / rules.ask / rules.deny") {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a list of strings`);
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
  const thinking = (raw.thinking ?? {}) as { level?: unknown; display?: unknown };
  if (thinking.level !== undefined && !THINKING_LEVELS.includes(thinking.level as ThinkingLevel)) {
    throw new Error(`thinking.level must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  if (thinking.display !== undefined && !THINKING_DISPLAYS.includes(thinking.display as ThinkingDisplay)) {
    throw new Error(`thinking.display must be one of: ${THINKING_DISPLAYS.join(", ")}`);
  }
  return {
    thinking: { level: thinking.level as ThinkingLevel | undefined, display: thinking.display as ThinkingDisplay | undefined },
    plugins: stringList(raw.plugins, DEFAULT_SETTINGS.plugins, "plugins"),
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
      settings: {
        jev: { mode: "off" },
        rules: { ...DEFAULT_SETTINGS.rules, allow: [] },
        plugins: [...DEFAULT_SETTINGS.plugins],
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The thinking level and display in effect, with defaults filled in. */
export function thinkingOf(settings: Settings) {
  return {
    level: settings.thinking?.level ?? DEFAULT_THINKING,
    display: settings.thinking?.display ?? DEFAULT_THINKING_DISPLAY,
  };
}

/** Change only thinking.level or thinking.display; keep everything else in the file. */
export function saveThinking(cwd: string, change: { level?: ThinkingLevel; display?: ThinkingDisplay }) {
  const raw = readRaw(cwd) ?? {};
  const thinking = (raw.thinking && typeof raw.thinking === "object" ? raw.thinking : {}) as Record<string, unknown>;
  raw.thinking = { ...thinking, ...change };
  mkdirSync(path.dirname(settingsPath(cwd)), { recursive: true });
  writeFileSync(settingsPath(cwd), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
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

/**
 * What rules match against: the shell command, or the path relative to the working folder with "/" separators.
 * With `cwd`, absolute paths inside the folder become relative ("C:\\proj\\.git\\x" → ".git/x"),
 * so "deny write .git/*" cannot be dodged by spelling the path out in full.
 */
export function ruleTarget(name: string, args: Record<string, unknown>, cwd?: string) {
  if (name === "shell") return String(args.command ?? "").trim();
  if (name === "webfetch") return urlHost(args.url);
  if (name === "websearch") return String(args.query ?? "").trim();
  let raw = String(args.path ?? ".");
  if (cwd) {
    // Resolve like the tools do, so "../proj/.git/x" and Windows "C:.git\\x" are ".git/x" too.
    const resolved = path.resolve(cwd, raw);
    const relative = path.relative(cwd, resolved);
    raw = !relative.startsWith("..") && !path.isAbsolute(relative) ? relative || "." : resolved;
  }
  const clean = path.posix.normalize(raw.replaceAll("\\", "/")).replace(/^\.\//, "");
  return clean || ".";
}

/** The host a URL points at, lower-cased, without a trailing dot; "" when it is not an http(s) URL. */
export function urlHost(value: unknown) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * Host rules, like Claude Code's WebFetch(domain:…): "docs.microsoft.com" exactly; "*.microsoft.com" any
 * subdomain (not microsoft.com itself); "*" alone any host; a "*" anywhere else never crosses a dot.
 */
function hostMatches(pattern: string, host: string) {
  const want = pattern.toLowerCase().replace(/\.$/, "");
  if (want === "*") return host.length > 0;
  if (!host) return false;
  if (want.startsWith("*.")) return host.endsWith(want.slice(1)) && host.length > want.length - 1;
  const body = want
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]*");
  return new RegExp(`^${body}$`).test(host);
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

/** Commands that run another command inside them; "always allow" is never offered for these. */
const WRAPPED =
  /(^|[\s&.])(pwsh|powershell|cmd|bash|sh|zsh|wsl|node|deno|python3?|py|php|perl|ruby)(\.exe)?([\s/-]|$)|\b(Invoke-Expression|iex|Start-Process|saps|start|Start-Job|sajb|Invoke-Command|icm|Invoke-Item|ii)\b|\s-(c|command|encodedcommand|e|file|eval)(\s|$)|--eval\b|\/c(\s|$)|(^|\s)\.\s|\.ps1\b/i;

function shellPieces(command: string) {
  return [command, ...command.split(/[;&|\n\r]+/).map((piece) => piece.trim()).filter(Boolean)];
}

function matches(rule: string, action: RuleAction, name: string, target: string) {
  const { tool, pattern } = splitRule(rule);
  // "mcp__github__*" names every tool of one MCP server; core tool names always match exactly
  // (so "allow *" does not quietly become "allow every tool").
  const toolGlob = tool.startsWith("mcp__") && tool.includes("*");
  if (toolGlob ? !globToRegex(tool).test(name.toLowerCase()) : tool !== name.toLowerCase()) return false;
  if (name === "webfetch") return hostMatches(pattern, target);
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
  cwd?: string,
): RuleMatch | undefined {
  const target = ruleTarget(name, args, cwd);
  for (const action of ["deny", "ask", "allow"] as const) {
    const rule = settings.rules[action].find((candidate) => matches(candidate, action, name, target));
    if (rule) return { action, rule };
  }
  return undefined;
}

/** Anything that is not a plain read or search may change something (MCP and unknown tools included). */
export function isMutation(name: string) {
  return name !== "read" && name !== "grep";
}

/**
 * The narrow allow rule an "always allow" answer saves, or undefined when it must not be offered.
 * Offered only for grey-zone calls (no rule matched): an ask rule (Remove-Item, git push…) keeps asking.
 * write/edit → that folder and everything under it ("edit scripts/*"), or the exact file at the top level. shell → that exact
 * command, never a chained or redirected one. Never for .git, .harness or .aegis.
 */
export function suggestAllowRule(
  name: string,
  args: Record<string, unknown>,
  matched: RuleMatch | undefined,
  cwd?: string,
) {
  if (matched) return undefined;
  if (name === "webfetch") {
    // "Always allow" for that exact host only.
    const host = urlHost(args.url);
    return host && !host.includes("*") ? `webfetch ${host}` : undefined;
  }
  if (name === "shell") {
    const command = ruleTarget(name, args);
    if (!command || CHAIN.test(command) || command.includes("*") || WRAPPED.test(command)) return undefined;
    return `shell ${command}`;
  }
  if (name === "write" || name === "edit") {
    const target = ruleTarget(name, args, cwd);
    // Only plain paths inside the folder: never absolute, "..", ".", or the protected folders.
    if (!target || target === "." || target.includes("*") || target.startsWith("/") || /^[a-z]:/i.test(target)) return undefined;
    if (/^\.\.(\/|$)/.test(target) || /^(\.git|\.harness|\.aegis)(\/|$)/i.test(target)) return undefined;
    const dir = path.posix.dirname(target);
    return dir === "." ? `${name} ${target}` : `${name} ${dir}/*`;
  }
  return undefined;
}

/** Add an allow rule to .aegis/settings.json (keeping the default allow list when the file had none). */
export function saveAllowRule(cwd: string, rule: string) {
  const raw = readRaw(cwd) ?? {};
  const rules = (raw.rules && typeof raw.rules === "object" ? raw.rules : {}) as Record<string, unknown>;
  const allow = Array.isArray(rules.allow) ? (rules.allow as string[]) : [...DEFAULT_SETTINGS.rules.allow];
  if (!allow.includes(rule)) allow.push(rule);
  raw.rules = { ...rules, allow };
  mkdirSync(path.dirname(settingsPath(cwd)), { recursive: true });
  writeFileSync(settingsPath(cwd), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}
