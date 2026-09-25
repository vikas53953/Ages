import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userAegisDir } from "./env.ts";
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
    allow: ["read *", "grep *", "skill *", "explore *"],
  },
  plugins: ["jev", "delivery", "receipts"],
};

export function settingsPath(cwd: string) {
  return path.join(cwd, ".aegis", "settings.json");
}

/** Always on, whatever any file says: the lock's own files are asked about even when a rule allows writes. */
export const FLOOR_ASK = [
  "write .aegis/*",
  "edit .aegis/*",
  // Secrets: reading them is asked about every time (no "always"), and output is redacted anyway (redact.ts).
  "read *.env",
  "read *.env.*",
  "read *.pem",
  "read *.key",
  "read *.pfx",
  "read *.p12",
  "read *.kdbx",
  "read *id_rsa*",
  "read *id_ed25519*",
  "read *id_ecdsa*",
  "read *.aws/credentials",
  "read *.ssh/*",
];

/** One spelling per folder: the real path, lower-cased on Windows (C:\\Proj and c:\\proj are the same folder). */
export function projectKey(cwd: string) {
  let real = path.resolve(cwd);
  try {
    real = realpathSync.native(real);
  } catch {
    // not there yet: the resolved path
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * YOUR settings for this folder: "always allow" rules, /jev and /think land here, in ~/.aegis, where the
 * model's tools cannot write and a cloned repo cannot ship them.
 */
export function yourSettingsPath(cwd: string) {
  const id = createHash("sha256").update(projectKey(cwd)).digest("hex").slice(0, 16);
  return path.join(userAegisDir(), "projects", id, "settings.json");
}

function trustFile() {
  return path.join(userAegisDir(), "trusted-settings.json");
}

function readTrust(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(trustFile(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function parseObject(text: string, file: string) {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The project's file, read once: the same bytes are hashed for trust and parsed. A link (the .aegis folder or
 * the file) is refused, so a repo cannot point Aegis at another file.
 */
function readProject(cwd: string): { raw: Record<string, unknown>; hash: string } | undefined {
  const file = settingsPath(cwd);
  for (const item of [path.dirname(file), file]) {
    let info;
    try {
      info = lstatSync(item);
    } catch {
      return undefined;
    }
    if (info.isSymbolicLink()) throw new Error(`${item} is a link; Aegis only reads a real .aegis/settings.json`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return undefined;
  }
  return { raw: parseObject(bytes.toString("utf8"), file), hash: createHash("sha256").update(bytes).digest("hex") };
}

function readYours(cwd: string): Record<string, unknown> | undefined {
  const file = yourSettingsPath(cwd);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  return parseObject(text, file);
}

function stringList(value: unknown, fallback: string[], name = "rules.allow / rules.ask / rules.deny") {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a list of strings`);
  }
  return value as string[];
}

type Parsed = {
  jevMode?: JevMode;
  thinking: { level?: ThinkingLevel; display?: ThinkingDisplay };
  plugins?: string[];
  deny?: string[];
  ask?: string[];
  allow?: string[];
};

function parseSettings(raw: Record<string, unknown>): Parsed {
  const jev = (raw.jev ?? {}) as { mode?: unknown };
  if (jev.mode !== undefined && !JEV_MODES.includes(jev.mode as JevMode)) {
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
  const optional = (value: unknown, name?: string) => (value === undefined ? undefined : stringList(value, [], name));
  return {
    jevMode: jev.mode as JevMode | undefined,
    thinking: { level: thinking.level as ThinkingLevel | undefined, display: thinking.display as ThinkingDisplay | undefined },
    plugins: optional(raw.plugins, "plugins"),
    deny: optional(rules.deny),
    ask: optional(rules.ask),
    allow: optional(rules.allow),
  };
}

const unique = (items: string[]) => [...new Set(items)];

export type ProjectTrust = {
  /** Is there a .aegis/settings.json in the folder at all? */
  exists: boolean;
  trusted: boolean;
  /** What the untrusted file asks for that is not used until /trust (allow rules, plugin list). */
  ignored: string[];
  hash?: string;
};

/** Trust a project file in headless runs you control (CI): the real environment only, never a project .env. */
function trustedByEnv() {
  return process.env.AEGIS_TRUST_PROJECT === "1";
}

/**
 * The rules in effect, from three layers:
 *  - the floor (default deny and ask rules, and asking before writes to .aegis) — always on;
 *  - the project's .aegis/settings.json — its deny/ask rules, Jev mode and thinking always apply (they can only
 *    make things stricter or cost more), but its allow rules and plugin list only after you /trust that exact file;
 *  - your settings for this folder in ~/.aegis/projects (always allow rules, /jev, /think) — always trusted.
 * A broken file throws: the caller fails safe.
 */
export function loadSettingsWithTrust(cwd: string): { settings: Settings; trust: ProjectTrust } {
  const project = readProject(cwd);
  const mine = readYours(cwd);
  const p = project ? parseSettings(project.raw) : ({ thinking: {} } as Parsed);
  const m = mine ? parseSettings(mine) : ({ thinking: {} } as Parsed);
  const trusted = !project || trustedByEnv() || readTrust()[projectKey(cwd)] === project.hash;
  const ignored: string[] = [];
  // An untrusted file may only make things stricter: its deny/ask rules and "jev off" (with Jev off, unscored
  // calls ask you). Allow rules, plugins, a busier Jev mode and a higher thinking level (your tokens) wait for /trust.
  // Not even "off": with Jev off every turn goes to the frontier model, which a cloned repo must not choose.
  const projectJev = trusted ? p.jevMode : undefined;
  const projectThinking = trusted ? p.thinking : {};
  if (project && !trusted) {
    for (const rule of p.allow ?? []) if (!DEFAULT_SETTINGS.rules.allow.includes(rule)) ignored.push(`allow ${rule}`);
    if (p.plugins && p.plugins.join(",") !== DEFAULT_SETTINGS.plugins.join(",")) ignored.push(`plugins [${p.plugins.join(", ")}]`);
    if (p.jevMode) ignored.push(`jev ${p.jevMode}`);
    if (p.thinking.level) ignored.push(`thinking ${p.thinking.level}`);
  }
  const settings: Settings = {
    thinking: { level: m.thinking.level ?? projectThinking.level, display: m.thinking.display ?? p.thinking.display },
    plugins: [...(m.plugins ?? (trusted ? p.plugins : undefined) ?? DEFAULT_SETTINGS.plugins)],
    jev: { mode: m.jevMode ?? projectJev ?? DEFAULT_SETTINGS.jev.mode },
    rules: {
      deny: unique([...DEFAULT_SETTINGS.rules.deny, ...(p.deny ?? []), ...(m.deny ?? [])]),
      ask: unique([...DEFAULT_SETTINGS.rules.ask, ...FLOOR_ASK, ...(p.ask ?? []), ...(m.ask ?? [])]),
      // Lists add up: the default reads stay allowed (to make reads ask, add an ask rule such as "ask read *").
      allow: unique([...DEFAULT_SETTINGS.rules.allow, ...((trusted ? p.allow : undefined) ?? []), ...(m.allow ?? [])]),
    },
  };
  return { settings, trust: { exists: Boolean(project), trusted, ignored, hash: project?.hash } };
}

export function loadSettings(cwd: string): Settings {
  return loadSettingsWithTrust(cwd).settings;
}

/** Settings that cannot be read fall back to Jev off and no allow rules: everything but a hard deny asks you. */
export function loadSettingsSafe(cwd: string): { settings: Settings; error?: string; trust?: ProjectTrust } {
  try {
    const loaded = loadSettingsWithTrust(cwd);
    return { settings: loaded.settings, trust: loaded.trust };
  } catch (error) {
    return {
      settings: {
        jev: { mode: "off" },
        rules: { ...DEFAULT_SETTINGS.rules, ask: [...DEFAULT_SETTINGS.rules.ask, ...FLOOR_ASK], allow: [] },
        plugins: [...DEFAULT_SETTINGS.plugins],
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Trust the project's .aegis/settings.json as it is now (these exact bytes), or stop trusting it. */
export function setProjectTrust(cwd: string, hash: string | undefined) {
  const store = readTrust();
  if (hash) store[projectKey(cwd)] = hash;
  else delete store[projectKey(cwd)];
  mkdirSync(userAegisDir(), { recursive: true });
  writeFileSync(trustFile(), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

/** Change YOUR settings for this folder (never the project's file); keeps everything else in it. */
function updateYours(cwd: string, change: (raw: Record<string, unknown>) => void) {
  const file = yourSettingsPath(cwd);
  const raw = readYours(cwd) ?? {};
  raw.project = path.resolve(cwd); // for people reading the file
  change(raw);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
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
  updateYours(cwd, (raw) => {
    const thinking = (raw.thinking && typeof raw.thinking === "object" ? raw.thinking : {}) as Record<string, unknown>;
    raw.thinking = { ...thinking, ...change };
  });
}

/** Change only jev.mode; keep everything else in the file. */
export function saveJevMode(cwd: string, mode: JevMode) {
  updateYours(cwd, (raw) => {
    const jev = (raw.jev && typeof raw.jev === "object" ? raw.jev : {}) as Record<string, unknown>;
    raw.jev = { ...jev, mode };
  });
}

export function parseJevMode(text: string): JevMode | undefined {
  const key = text.trim().toLowerCase();
  if (key === "off") return "off";
  if (key === "second" || key === "second-opinion") return "second-opinion";
  if (key === "every" || key === "every-call") return "every-call";
  return undefined;
}

/** The real path (links, junctions and 8.3 names expanded); for a path that does not exist yet, its nearest
 * existing folder's real path plus the rest. */
function realPathOf(absolute: string) {
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * What rules match against: the shell command, or the path relative to the working folder with "/" separators.
 * With `cwd`, absolute paths inside the folder become relative ("C:\\proj\\.git\\x" → ".git/x"),
 * so "deny write .git/*" cannot be dodged by spelling the path out in full.
 */
export function ruleTarget(name: string, args: Record<string, unknown>, cwd?: string) {
  if (name === "shell") return String(args.command ?? "").trim();
  if (name === "webfetch") return urlHost(args.url);
  if (name === "websearch" || name === "explore") return String(args.query ?? args.task ?? "").trim();
  let raw = String(args.path ?? ".");
  if (cwd) {
    // Resolve like the tools do, so "../proj/.git/x" and Windows "C:.git\\x" are ".git/x" too. Real paths on
    // both sides: a link to .aegis ("cfg/settings.json") or a Windows short name (AEGIS~1) is still ".aegis/…".
    const root = realPathOf(path.resolve(cwd));
    const resolved = realPathOf(path.resolve(cwd, raw));
    const relative = path.relative(root, resolved);
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
  let want = pattern.toLowerCase().replace(/\.$/, "");
  // "*" covers every fetch, even one with no web host (so "deny webfetch *" also stops file: and the like).
  if (want === "*") return true;
  // bücher.de and xn--bcher-kva.de are the same host.
  if (!want.includes("*")) {
    try {
      want = new URL(`http://${want}`).hostname;
    } catch {
      // not a host name: compared as written
    }
  }
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
  return name !== "read" && name !== "grep" && name !== "todo" && name !== "skill" && name !== "explore";
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
  if (name === "explore") return "explore *"; // it only reads, and each of its reads passes the lock too
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
  updateYours(cwd, (raw) => {
    const rules = (raw.rules && typeof raw.rules === "object" ? raw.rules : {}) as Record<string, unknown>;
    const allow = Array.isArray(rules.allow) ? (rules.allow as string[]) : [];
    if (!allow.includes(rule)) allow.push(rule);
    raw.rules = { ...rules, allow };
  });
}
