import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_THINKING, DEFAULT_THINKING_DISPLAY, THINKING_DISPLAYS, THINKING_LEVELS, } from "./thinking.js";
export const JEV_MODES = ["off", "second-opinion", "every-call"];
/**
 * Defaults when .aegis/settings.json is missing or leaves a list out.
 * Anything no rule matches is "grey zone": Jev decides if it is on, otherwise you are asked.
 */
export const DEFAULT_SETTINGS = {
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
export function settingsPath(cwd) {
    return path.join(cwd, ".aegis", "settings.json");
}
function readRaw(cwd) {
    let text;
    try {
        text = readFileSync(settingsPath(cwd), "utf8");
    }
    catch {
        return undefined;
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${settingsPath(cwd)} must be a JSON object`);
    }
    return parsed;
}
function stringList(value, fallback, name = "rules.allow / rules.ask / rules.deny") {
    if (value === undefined)
        return [...fallback];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`${name} must be a list of strings`);
    }
    return value;
}
/** A list in the file replaces the default list of the same name. A broken file throws: the caller fails safe. */
export function loadSettings(cwd) {
    const raw = readRaw(cwd);
    if (!raw)
        return structuredClone(DEFAULT_SETTINGS);
    const jev = (raw.jev ?? {});
    const mode = jev.mode ?? DEFAULT_SETTINGS.jev.mode;
    if (!JEV_MODES.includes(mode)) {
        throw new Error(`jev.mode must be one of: ${JEV_MODES.join(", ")}`);
    }
    const rules = (raw.rules ?? {});
    const thinking = (raw.thinking ?? {});
    if (thinking.level !== undefined && !THINKING_LEVELS.includes(thinking.level)) {
        throw new Error(`thinking.level must be one of: ${THINKING_LEVELS.join(", ")}`);
    }
    if (thinking.display !== undefined && !THINKING_DISPLAYS.includes(thinking.display)) {
        throw new Error(`thinking.display must be one of: ${THINKING_DISPLAYS.join(", ")}`);
    }
    return {
        thinking: { level: thinking.level, display: thinking.display },
        plugins: stringList(raw.plugins, DEFAULT_SETTINGS.plugins, "plugins"),
        jev: { mode: mode },
        rules: {
            deny: stringList(rules.deny, DEFAULT_SETTINGS.rules.deny),
            ask: stringList(rules.ask, DEFAULT_SETTINGS.rules.ask),
            allow: stringList(rules.allow, DEFAULT_SETTINGS.rules.allow),
        },
    };
}
/** Settings that cannot be read fall back to Jev off and no allow rules: everything but a hard deny asks you. */
export function loadSettingsSafe(cwd) {
    try {
        return { settings: loadSettings(cwd) };
    }
    catch (error) {
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
export function thinkingOf(settings) {
    return {
        level: settings.thinking?.level ?? DEFAULT_THINKING,
        display: settings.thinking?.display ?? DEFAULT_THINKING_DISPLAY,
    };
}
/** Change only thinking.level or thinking.display; keep everything else in the file. */
export function saveThinking(cwd, change) {
    const raw = readRaw(cwd) ?? {};
    const thinking = (raw.thinking && typeof raw.thinking === "object" ? raw.thinking : {});
    raw.thinking = { ...thinking, ...change };
    mkdirSync(path.dirname(settingsPath(cwd)), { recursive: true });
    writeFileSync(settingsPath(cwd), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}
/** Change only jev.mode; keep everything else in the file. */
export function saveJevMode(cwd, mode) {
    const raw = readRaw(cwd) ?? {};
    const jev = (raw.jev && typeof raw.jev === "object" ? raw.jev : {});
    raw.jev = { ...jev, mode };
    mkdirSync(path.dirname(settingsPath(cwd)), { recursive: true });
    writeFileSync(settingsPath(cwd), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}
export function parseJevMode(text) {
    const key = text.trim().toLowerCase();
    if (key === "off")
        return "off";
    if (key === "second" || key === "second-opinion")
        return "second-opinion";
    if (key === "every" || key === "every-call")
        return "every-call";
    return undefined;
}
/**
 * What rules match against: the shell command, or the path relative to the working folder with "/" separators.
 * With `cwd`, absolute paths inside the folder become relative ("C:\\proj\\.git\\x" → ".git/x"),
 * so "deny write .git/*" cannot be dodged by spelling the path out in full.
 */
export function ruleTarget(name, args, cwd) {
    if (name === "shell")
        return String(args.command ?? "").trim();
    if (name === "webfetch")
        return urlHost(args.url);
    if (name === "websearch")
        return String(args.query ?? "").trim();
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
export function urlHost(value) {
    try {
        const url = new URL(String(value ?? ""));
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return "";
        return url.hostname.toLowerCase().replace(/\.$/, "");
    }
    catch {
        return "";
    }
}
/**
 * Host rules, like Claude Code's WebFetch(domain:…): "docs.microsoft.com" exactly; "*.microsoft.com" any
 * subdomain (not microsoft.com itself); "*" alone any host; a "*" anywhere else never crosses a dot.
 */
function hostMatches(pattern, host) {
    const want = pattern.toLowerCase().replace(/\.$/, "");
    if (want === "*")
        return host.length > 0;
    if (!host)
        return false;
    if (want.startsWith("*."))
        return host.endsWith(want.slice(1)) && host.length > want.length - 1;
    const body = want
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^.]*");
    return new RegExp(`^${body}$`).test(host);
}
function globToRegex(glob) {
    const body = glob
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${body}$`, "is");
}
/** "shell git push*" → tool "shell", pattern "git push*". A bare "shell" matches every shell call. */
function splitRule(rule) {
    const text = rule.trim();
    const space = text.indexOf(" ");
    if (space < 0)
        return { tool: text.toLowerCase(), pattern: "*" };
    return { tool: text.slice(0, space).toLowerCase(), pattern: text.slice(space + 1).trim() };
}
/** Characters that chain or redirect PowerShell commands. */
const CHAIN = /[;&|`\n\r<>]|\$\(/;
/** Commands that run another command inside them; "always allow" is never offered for these. */
const WRAPPED = /(^|[\s&.])(pwsh|powershell|cmd|bash|sh|zsh|wsl|node|deno|python3?|py|php|perl|ruby)(\.exe)?([\s/-]|$)|\b(Invoke-Expression|iex|Start-Process|saps|start|Start-Job|sajb|Invoke-Command|icm|Invoke-Item|ii)\b|\s-(c|command|encodedcommand|e|file|eval)(\s|$)|--eval\b|\/c(\s|$)|(^|\s)\.\s|\.ps1\b/i;
function shellPieces(command) {
    return [command, ...command.split(/[;&|\n\r]+/).map((piece) => piece.trim()).filter(Boolean)];
}
function matches(rule, action, name, target) {
    const { tool, pattern } = splitRule(rule);
    // "mcp__github__*" names every tool of one MCP server; other tool names match exactly.
    if (tool.includes("*") ? !globToRegex(tool).test(name.toLowerCase()) : tool !== name.toLowerCase())
        return false;
    if (name === "webfetch")
        return hostMatches(pattern, target);
    const regex = globToRegex(pattern);
    if (name !== "shell")
        return regex.test(target);
    // allow must cover the whole command, and never a chained one: "git status; Remove-Item x" is not "git status".
    if (action === "allow")
        return !CHAIN.test(target) && regex.test(target);
    // deny/ask catch the command anywhere in a chain.
    return shellPieces(target).some((piece) => regex.test(piece));
}
/** deny beats ask beats allow. Inside a list, the first rule that matches is reported. */
export function matchRule(settings, name, args, cwd) {
    const target = ruleTarget(name, args, cwd);
    for (const action of ["deny", "ask", "allow"]) {
        const rule = settings.rules[action].find((candidate) => matches(candidate, action, name, target));
        if (rule)
            return { action, rule };
    }
    return undefined;
}
export function isMutation(name) {
    return name === "write" || name === "edit" || name === "shell";
}
/**
 * The narrow allow rule an "always allow" answer saves, or undefined when it must not be offered.
 * Offered only for grey-zone calls (no rule matched): an ask rule (Remove-Item, git push…) keeps asking.
 * write/edit → that folder and everything under it ("edit scripts/*"), or the exact file at the top level. shell → that exact
 * command, never a chained or redirected one. Never for .git, .harness or .aegis.
 */
export function suggestAllowRule(name, args, matched, cwd) {
    if (matched)
        return undefined;
    if (name === "webfetch") {
        // "Always allow" for that exact host only.
        const host = urlHost(args.url);
        return host && !host.includes("*") ? `webfetch ${host}` : undefined;
    }
    if (name === "shell") {
        const command = ruleTarget(name, args);
        if (!command || CHAIN.test(command) || command.includes("*") || WRAPPED.test(command))
            return undefined;
        return `shell ${command}`;
    }
    if (name === "write" || name === "edit") {
        const target = ruleTarget(name, args, cwd);
        // Only plain paths inside the folder: never absolute, "..", ".", or the protected folders.
        if (!target || target === "." || target.includes("*") || target.startsWith("/") || /^[a-z]:/i.test(target))
            return undefined;
        if (/^\.\.(\/|$)/.test(target) || /^(\.git|\.harness|\.aegis)(\/|$)/i.test(target))
            return undefined;
        const dir = path.posix.dirname(target);
        return dir === "." ? `${name} ${target}` : `${name} ${dir}/*`;
    }
    return undefined;
}
/** Add an allow rule to .aegis/settings.json (keeping the default allow list when the file had none). */
export function saveAllowRule(cwd, rule) {
    const raw = readRaw(cwd) ?? {};
    const rules = (raw.rules && typeof raw.rules === "object" ? raw.rules : {});
    const allow = Array.isArray(rules.allow) ? rules.allow : [...DEFAULT_SETTINGS.rules.allow];
    if (!allow.includes(rule))
        allow.push(rule);
    raw.rules = { ...rules, allow };
    mkdirSync(path.dirname(settingsPath(cwd)), { recursive: true });
    writeFileSync(settingsPath(cwd), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}
