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
import { powershellExe } from "./tools/fs.js";
import { programPath } from "./which.js";
import { killProcessTree } from "./exec.js";
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
export function claudeToolName(name, args) {
    // An edit with a list of changes is Claude Code's MultiEdit (multi_edit, or Claude Code's own).
    if (name === "edit" && args?.edits !== undefined)
        return "MultiEdit";
    return CLAUDE_NAMES[name] ?? name;
}
/** Names a hook matcher is checked against: Aegis's, Claude Code's, and "Edit" for a MultiEdit too. */
function hookNames(name, args) {
    const claude = claudeToolName(name, args);
    return claude === "MultiEdit" ? [name, "multi_edit", "MultiEdit", "Edit"] : [name, claude];
}
function hooksFile() {
    return path.join(userAegisDir(), "settings.json");
}
function parseGroups(event, groups) {
    if (groups === undefined)
        return [];
    if (!Array.isArray(groups))
        return `hooks.${event} must be a list`;
    const out = [];
    for (const group of groups) {
        const g = group;
        const matcher = g?.matcher === undefined ? "*" : g.matcher;
        if (typeof matcher !== "string" || !Array.isArray(g?.hooks))
            return `each ${event} entry needs a matcher string and a hooks list`;
        try {
            if (!isPlainMatcher(matcher))
                new RegExp(matcher);
        }
        catch {
            return `bad matcher regex: ${matcher}`;
        }
        const hooks = [];
        for (const hook of g.hooks) {
            const h = hook;
            if (h?.type !== "command" || typeof h.command !== "string" || !h.command.trim()) {
                return 'each hook needs type "command" and a command';
            }
            if (h.args !== undefined && (!Array.isArray(h.args) || h.args.some((a) => typeof a !== "string"))) {
                return "hook args must be a list of strings";
            }
            const timeout = typeof h.timeout === "number" && h.timeout > 0 ? Math.min(h.timeout, MAX_TIMEOUT_S) : DEFAULT_TIMEOUT_S;
            hooks.push({ command: h.command, args: h.args, timeout });
        }
        out.push({ matcher, hooks });
    }
    return out;
}
/** Parse the hooks block (PreToolUse, PostToolUse). Anything malformed is reported, never half-used. */
export function parseHooks(raw) {
    const empty = { PreToolUse: [], PostToolUse: [] };
    if (raw === undefined)
        return empty;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return { ...empty, error: "hooks must be an object" };
    const pre = parseGroups("PreToolUse", raw.PreToolUse);
    if (typeof pre === "string")
        return { ...empty, error: pre };
    const post = parseGroups("PostToolUse", raw.PostToolUse);
    if (typeof post === "string")
        return { ...empty, error: post };
    return { PreToolUse: pre, PostToolUse: post };
}
/** Your hooks from ~/.aegis/settings.json. */
export function loadHooks() {
    let text;
    try {
        text = readFileSync(hooksFile(), "utf8");
    }
    catch (error) {
        // No file: no hooks. Any other failure (locked by an editor, a folder, no access) must not drop your guards.
        if (error.code === "ENOENT")
            return { PreToolUse: [] };
        return { PreToolUse: [], error: `${hooksFile()} could not be read (${error.message})` };
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
        // POSIX: its own process group, so a timeout ends the hook and whatever it started.
        const posix = process.platform !== "win32";
        let child;
        try {
            child = hook.args
                ? spawn(programPath(hook.command), hook.args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: posix })
                : process.platform === "win32"
                    ? spawn(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", hook.command], {
                        cwd,
                        env,
                        windowsHide: true,
                        stdio: ["pipe", "pipe", "pipe"],
                    })
                    : spawn("sh", ["-c", hook.command], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: posix });
        }
        catch (error) {
            resolve({ code: null, stdout: "", stderr: "", failed: error instanceof Error ? error.message : String(error) });
            return;
        }
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let done = false;
        const finish = (result) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve({ ...result, stdout, stderr, truncated });
        };
        // The hook and anything it started (taskkill /T on Windows, the process group elsewhere).
        const kill = () => {
            if (child.pid)
                killProcessTree(child.pid);
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
            if (stdout.length + chunk.length > MAX_OUTPUT)
                truncated = true;
            if (stdout.length < MAX_OUTPUT)
                stdout = (stdout + chunk.toString("utf8")).slice(0, MAX_OUTPUT);
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
    // Plain text is "no objection". Text that starts like JSON but cannot be read was meant as an answer: ask.
    if (!text.startsWith("{"))
        return undefined;
    if (result.truncated)
        return { action: "ask", reason: `hook ${name} printed more than Aegis reads, so Aegis asks`, hook: name };
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return { action: "ask", reason: `hook ${name} printed JSON Aegis could not read, so Aegis asks`, hook: name };
    }
    const specific = (parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === "object" ? parsed.hookSpecificOutput : {});
    // Claude Code reads hookSpecificOutput; a decision given at the top level counts too (tighten-only, so no harm).
    const decision = String(specific.permissionDecision ?? parsed.permissionDecision ?? parsed.decision ?? "").toLowerCase();
    const why = String(specific.permissionDecisionReason ?? parsed.permissionDecisionReason ?? parsed.reason ?? "").slice(0, 500);
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
/** Claude Code's tool_input: file_path (absolute) and content next to Aegis's path and contents. */
function claudeInput(args, cwd) {
    const toolInput = { ...args };
    if (typeof args.path === "string" && toolInput.file_path === undefined)
        toolInput.file_path = path.resolve(cwd, args.path);
    if (typeof args.contents === "string" && toolInput.content === undefined)
        toolInput.content = args.contents;
    // multi_edit carries its edits as JSON text: hooks get them as Claude Code's MultiEdit list.
    if (typeof args.edits === "string") {
        try {
            toolInput.edits = JSON.parse(args.edits);
        }
        catch {
            // leave as text
        }
    }
    // A scanner written for Edit reads new_string: give it every change's new text too.
    if (Array.isArray(toolInput.edits) && toolInput.new_string === undefined) {
        const edits = toolInput.edits;
        toolInput.new_string = edits.map((edit) => String(edit?.new_string ?? "")).join("\n");
        toolInput.old_string = edits.map((edit) => String(edit?.old_string ?? "")).join("\n");
    }
    return toolInput;
}
export async function runPreToolHooks(input) {
    if (input.config.error)
        return { action: "ask", reason: `your hooks are not valid (${input.config.error}), so Aegis asks`, hook: "settings" };
    const names = hookNames(input.name, input.args);
    const hooks = input.config.PreToolUse.filter((group) => matcherMatches(group.matcher, names)).flatMap((group) => group.hooks);
    if (!hooks.length)
        return undefined;
    const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd: input.cwd,
        permission_mode: input.readOnly ? "plan" : "default",
        tool_name: claudeToolName(input.name, input.args),
        tool_input: claudeInput(input.args, input.cwd),
        aegis_tool_name: input.name,
    });
    const results = await Promise.all(hooks.map(async (hook) => verdictOf(await spawnHook(hook, payload, input.cwd, input.signal), hook)));
    return results.find((result) => result?.action === "deny") ?? results.find((result) => result?.action === "ask");
}
/**
 * PostToolUse (Claude Code's semantics): the tool already ran, so a hook cannot stop it, but what it says goes
 * back to the model with the result. Exit 2 or {"decision":"block","reason":…} is feedback the model must act
 * on (a linter or secret scanner that failed); hookSpecificOutput.additionalContext is added as a note. A hook
 * that crashes or times out is reported, so a check that did not run is never mistaken for a pass.
 */
export async function runPostToolHooks(input) {
    const names = hookNames(input.name, input.args);
    const hooks = (input.config.PostToolUse ?? []).filter((group) => matcherMatches(group.matcher, names)).flatMap((group) => group.hooks);
    if (!hooks.length)
        return [];
    const payload = JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd: input.cwd,
        tool_name: claudeToolName(input.name, input.args),
        tool_input: claudeInput(input.args, input.cwd),
        tool_response: input.output.slice(0, MAX_OUTPUT),
        aegis_tool_name: input.name,
    });
    const notes = await Promise.all(hooks.map(async (hook) => {
        const name = label(hook);
        const result = await spawnHook(hook, payload, input.cwd, input.signal);
        if (result.failed)
            return `[hook ${name} did not run to the end (${result.failed}); its check is unknown]`;
        if (result.code === 2)
            return `[hook ${name} reports a problem: ${result.stderr.trim().slice(0, 2000) || "no details"}]`;
        if (result.code !== 0)
            return `[hook ${name} failed with exit code ${result.code}; its check is unknown]`;
        const text = result.stdout.trim();
        if (!text.startsWith("{"))
            return "";
        try {
            const parsed = JSON.parse(text);
            const specific = (parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === "object" ? parsed.hookSpecificOutput : {});
            const parts = [];
            if (String(parsed.decision ?? "").toLowerCase() === "block")
                parts.push(`[hook ${name} reports a problem: ${String(parsed.reason ?? "no details").slice(0, 2000)}]`);
            if (typeof specific.additionalContext === "string" && specific.additionalContext.trim()) {
                parts.push(`[hook ${name}: ${specific.additionalContext.trim().slice(0, 2000)}]`);
            }
            return parts.join("\n");
        }
        catch {
            return `[hook ${name} printed JSON Aegis could not read]`;
        }
    }));
    return notes.filter(Boolean);
}
