import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
    return {
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
/** What a rule is matched against: the file path for read/write/edit/grep, the command for shell. */
export function ruleTarget(name, args) {
    if (name === "shell")
        return String(args.command ?? "").trim();
    const raw = String(args.path ?? ".").replaceAll("\\", "/");
    const clean = path.posix.normalize(raw).replace(/^\.\//, "");
    return clean || ".";
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
function shellPieces(command) {
    return [command, ...command.split(/[;&|\n\r]+/).map((piece) => piece.trim()).filter(Boolean)];
}
function matches(rule, action, name, target) {
    const { tool, pattern } = splitRule(rule);
    if (tool !== name.toLowerCase())
        return false;
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
export function matchRule(settings, name, args) {
    const target = ruleTarget(name, args);
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
