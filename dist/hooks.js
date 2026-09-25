/**
 * Hooks in Claude Code's format, read from YOUR ~/.aegis/settings.json (never from a project folder):
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "Bash|Write", "hooks": [ { "type": "command", "command": "...", "timeout": 30 } ] } ] } }
 *
 * They can only make the lock stricter. A PreToolUse hook may deny a call (exit 2, or JSON permissionDecision
 * "deny") or make Aegis ask you ("ask"); "allow" is ignored, because rules decide what runs without asking.
 * A hook that crashes or times out turns the call into a question (headless: denied), so a broken guard never
 * lets things through silently. The hook gets Claude Code's JSON on stdin (tool_name uses Claude Code's names,
 * tool_input has file_path next to path), so existing scripts work unchanged.
 *
 * Commands run as you, like any program you configured: PowerShell on Windows (sh elsewhere), or exec form
 * with "args". Nothing here is influenced by the project or the model other than the JSON on stdin.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { userAegisDir } from "./env.js";
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;
const MAX_OUTPUT = 64_000;
/** Aegis tool → Claude Code's name, so matchers and scripts written for Claude Code work. */
const CLAUDE_NAMES = {
    shell: "Bash",
    write: "Write",
    edit: "Edit",
    read: "Read",
    grep: "Grep",
    webfetch: "WebFetch",
    websearch: "WebSearch",
    todo: "TodoWrite",
    skill: "Skill",
};
export function claudeToolName(name) {
    return CLAUDE_NAMES[name] ?? name;
}
function hooksFile() {
    return path.join(userAegisDir(), "settings.json");
}
/** Parse the hooks block. Anything malformed is reported, never half-used. */
export function parseHooks(raw) {
    const empty = { PreToolUse: [] };
    if (raw === undefined)
        return empty;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return { ...empty, error: "hooks must be an object" };
    const groups = raw.PreToolUse;
    if (groups === undefined)
        return empty;
    if (!Array.isArray(groups))
        return { ...empty, error: "hooks.PreToolUse must be a list" };
    const out = [];
    for (const group of groups) {
        const g = group;
        const matcher = g?.matcher === undefined ? "*" : g.matcher;
        if (typeof matcher !== "string" || !Array.isArray(g?.hooks))
            return { ...empty, error: "each PreToolUse entry needs a matcher string and a hooks list" };
        try {
            if (!isPlainMatcher(matcher))
                new RegExp(matcher);
        }
        catch {
            return { ...empty, error: `bad matcher regex: ${matcher}` };
        }
        const hooks = [];
        for (const hook of g.hooks) {
            const h = hook;
            if (h?.type !== "command" || typeof h.command !== "string" || !h.command.trim()) {
                return { ...empty, error: 'each hook needs type "command" and a command' };
            }
            if (h.args !== undefined && (!Array.isArray(h.args) || h.args.some((a) => typeof a !== "string"))) {
                return { ...empty, error: "hook args must be a list of strings" };
            }
            const timeout = typeof h.timeout === "number" && h.timeout > 0 ? Math.min(h.timeout, MAX_TIMEOUT_S) : DEFAULT_TIMEOUT_S;
            hooks.push({ command: h.command, args: h.args, timeout });
        }
        out.push({ matcher, hooks });
    }
    return { PreToolUse: out };
}
/** Your hooks from ~/.aegis/settings.json. */
export function loadHooks() {
    let text;
    try {
        text = readFileSync(hooksFile(), "utf8");
    }
    catch {
        return { PreToolUse: [] };
    }
    try {
        const parsed = JSON.parse(text);
        return parseHooks(parsed && typeof parsed === "object" ? parsed.hooks : undefined);
    }
    catch (error) {
        return { PreToolUse: [], error: `${hooksFile()} is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
    }
}
function isPlainMatcher(matcher) {
    return /^[\w|*-]*$/.test(matcher);
}
/** Claude Code's rule: "*" or "" = all; letters, digits, _ and | = exact names; anything else is a regex. */
export function matcherMatches(matcher, names) {
    if (matcher === "" || matcher === "*")
        return true;
    if (isPlainMatcher(matcher) && !matcher.includes("*"))
        return matcher.split("|").some((part) => names.includes(part));
    let re;
    try {
        re = new RegExp(matcher.includes("*") && isPlainMatcher(matcher) ? `^(?:${matcher.replace(/\*/g, ".*")})$` : matcher);
    }
    catch {
        return false;
    }
    return names.some((name) => re.test(name));
}
function spawnHook(hook, stdin, cwd, signal) {
    return new Promise((resolve) => {
        const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd, AEGIS_PROJECT_DIR: cwd };
        let child;
        try {
            child = hook.args
                ? spawn(hook.command, hook.args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
                : process.platform === "win32"
                    ? spawn(process.env.AEGIS_POWERSHELL || "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", hook.command], {
                        cwd,
                        env,
                        windowsHide: true,
                        stdio: ["pipe", "pipe", "pipe"],
                    })
                    : spawn("sh", ["-c", hook.command], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        }
        catch (error) {
            resolve({ code: null, stdout: "", stderr: "", failed: error instanceof Error ? error.message : String(error) });
            return;
        }
        let stdout = "";
        let stderr = "";
        let done = false;
        const finish = (result) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve({ ...result, stdout, stderr });
        };
        const kill = () => {
            try {
                child.kill();
            }
            catch {
                // already gone
            }
        };
        const timer = setTimeout(() => {
            kill();
            finish({ code: null, failed: `timed out after ${hook.timeout}s` });
        }, hook.timeout * 1000);
        const onAbort = () => {
            kill();
            finish({ code: null, failed: "stopped" });
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (chunk) => {
            if (stdout.length < MAX_OUTPUT)
                stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            if (stderr.length < MAX_OUTPUT)
                stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => finish({ code: null, failed: error.message }));
        child.on("close", (code) => finish({ code }));
        child.stdin.on("error", () => undefined);
        child.stdin.end(stdin);
    });
}
function label(hook) {
    const text = [hook.command, ...(hook.args ?? [])].join(" ");
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}
/** Read one hook's answer. Only deny and ask count; allow and anything else mean "no objection". */
function verdictOf(result, hook) {
    const name = label(hook);
    if (result.failed)
        return { action: "ask", reason: `hook ${name} failed (${result.failed}), so Aegis asks`, hook: name };
    if (result.code === 2)
        return { action: "deny", reason: result.stderr.trim().slice(0, 500) || `blocked by hook ${name}`, hook: name };
    if (result.code !== 0)
        return { action: "ask", reason: `hook ${name} exited with ${result.code}, so Aegis asks`, hook: name };
    const text = result.stdout.trim();
    if (!text.startsWith("{"))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    const specific = (parsed.hookSpecificOutput ?? {});
    const decision = String(specific.permissionDecision ?? parsed.decision ?? "").toLowerCase();
    const why = String(specific.permissionDecisionReason ?? parsed.reason ?? "").slice(0, 500);
    if (decision === "deny" || decision === "block")
        return { action: "deny", reason: why || `blocked by hook ${name}`, hook: name };
    if (decision === "ask")
        return { action: "ask", reason: why || `hook ${name} wants you to decide`, hook: name };
    if (parsed.continue === false)
        return { action: "deny", reason: String(parsed.stopReason ?? "") || `blocked by hook ${name}`, hook: name };
    return undefined;
}
/**
 * Run the PreToolUse hooks that match this call, in parallel. The strictest answer wins: any deny denies;
 * otherwise any ask asks. With no hooks configured this costs nothing.
 */
export async function runPreToolHooks(input) {
    if (input.config.error)
        return { action: "ask", reason: `your hooks are not valid (${input.config.error}), so Aegis asks`, hook: "settings" };
    const names = [input.name, claudeToolName(input.name)];
    const hooks = input.config.PreToolUse.filter((group) => matcherMatches(group.matcher, names)).flatMap((group) => group.hooks);
    if (!hooks.length)
        return undefined;
    const toolInput = { ...input.args };
    if (typeof input.args.path === "string" && toolInput.file_path === undefined)
        toolInput.file_path = path.resolve(input.cwd, input.args.path);
    if (typeof input.args.contents === "string" && toolInput.content === undefined)
        toolInput.content = input.args.contents;
    const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: input.cwd,
        permission_mode: input.readOnly ? "plan" : "default",
        tool_name: claudeToolName(input.name),
        tool_input: toolInput,
        aegis_tool_name: input.name,
    });
    const results = await Promise.all(hooks.map(async (hook) => verdictOf(await spawnHook(hook, payload, input.cwd, input.signal), hook)));
    return results.find((result) => result?.action === "deny") ?? results.find((result) => result?.action === "ask");
}
