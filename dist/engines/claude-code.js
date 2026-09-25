/**
 * Claude Code as an engine: `/model claude-code` hands a turn to the real, unmodified Claude Code that you
 * signed in to with your own Claude plan (Anthropic permits exactly this). Aegis keeps the lock: Claude
 * Code calls scripts/claude-hook.mjs before every tool, the hook asks this process, and the same rules,
 * Jev and y/a/N approvals decide. If Aegis cannot answer, the hook blocks the call.
 *
 * Claude Code runs headless: `claude -p --output-format stream-json --verbose`, prompt on stdin,
 * `--resume` keeps one Claude conversation per Aegis session.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { packageRoot } from "../env.js";
import { killProcessTree } from "../exec.js";
import { serializeConfirm } from "../confirm-queue.js";
import { shellAllowed } from "../tools/shell.js";
import { cleanTodos } from "../todos.js";
import { runGatedTool, toolTarget } from "../gated.js";
import { scorerOf, toolGuards } from "../plugin-api.js";
import { unscoredTurn } from "../router.js";
import { sessionDir } from "../session.js";
import { findOnPath, NO_CWD_SEARCH_ENV } from "../which.js";
export const CLAUDE_CODE_MODEL = "claude-code";
/** Where `claude` is: AEGIS_CLAUDE_BIN, else the first `claude` on PATH. */
export function findClaude(env = process.env) {
    const override = env.AEGIS_CLAUDE_BIN;
    if (override)
        return path.isAbsolute(override) ? (existsSync(override) ? override : undefined) : findOnPath(override, env);
    // PATH folders only, never the project folder. On Windows prefer the real program (claude.exe) over npm's claude.cmd shim.
    if (process.platform === "win32")
        return findOnPath("claude.exe", env) ?? findOnPath("claude", env);
    return findOnPath("claude", env);
}
export const CLAUDE_MISSING = "Claude Code is not installed (or not on PATH). Install it from https://claude.com/claude-code, run `claude` once to sign in with your Claude plan, then /model claude-code again.";
/** Claude Code's tool call → the name and arguments Aegis rules match ("edit src/*", "shell npm test*"). */
export function toAegisCall(tool, input) {
    const file = input.file_path ?? input.notebook_path ?? input.path;
    switch (tool) {
        case "Read":
            return { name: "read", args: { path: file } };
        case "Write":
            return { name: "write", args: { path: file, contents: input.content } };
        case "Edit":
        case "MultiEdit":
        case "NotebookEdit":
            return { name: "edit", args: { path: file, old_string: input.old_string, new_string: input.new_string } };
        case "Bash":
        case "PowerShell":
            return { name: "shell", args: { command: input.command } };
        case "Grep":
            return { name: "grep", args: { pattern: input.pattern, path: input.path ?? "." } };
        case "Glob":
            return { name: "glob", args: { pattern: input.pattern, path: input.path ?? "." } };
        case "WebFetch":
            return { name: "webfetch", args: { url: String(input.url ?? ""), prompt: input.prompt } };
        case "Skill":
            // Named like Aegis's own skill tool, so "deny skill <name>" works for Claude Code too.
            return { name: "skill", args: { path: String(input.skill ?? input.name ?? "") } };
        case "WebSearch":
            return { name: "websearch", args: { query: String(input.query ?? "") } };
        default:
            return { name: tool.toLowerCase(), args: input };
    }
}
/** Claude Code's hook gives up after this; an unanswered question is answered No well before it. */
const HOOK_TIMEOUT_S = 86_400;
const APPROVAL_LIMIT_MS = (HOOK_TIMEOUT_S - 600) * 1000;
const MAX_HOOK_BODY = 2_000_000;
/** Tools whose target is a file: Claude Code may only touch files inside the project, like Aegis's own tools. */
const FILE_TOOLS = new Set(["read", "write", "edit", "grep"]);
/** The reason to refuse before any rule is asked, or undefined. Mirrors what Aegis's own tools enforce when they run. */
export function hardDeny(name, args, cwd, protectedFiles) {
    if (name === "shell" && !shellAllowed()) {
        return "Shell is disabled in Aegis (it is not confined to the folder). Set AEGIS_ALLOW_SHELL=1 to allow it.";
    }
    if (FILE_TOOLS.has(name) && typeof args.path === "string" && args.path) {
        const resolved = path.resolve(cwd, args.path);
        const relative = path.relative(path.resolve(cwd), resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative))
            return `${args.path} is outside the project folder`;
        if ((name === "write" || name === "edit") && protectedFiles.some((file) => path.resolve(file) === resolved)) {
            return "that file is part of Aegis's lock";
        }
        // Hard, whatever your rules say (a custom deny list replaces the defaults): Aegis's own tools refuse these too.
        if ((name === "write" || name === "edit") && /^(\.git|\.harness)([\\/]|$)/i.test(relative)) {
            return ".git and .harness are not writable";
        }
    }
    return undefined;
}
/** Claude Code bookkeeping that touches nothing outside the conversation. */
const HARMLESS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ExitPlanMode", "EnterPlanMode"]);
function claudeSessionFile(cwd, sessionId) {
    return path.join(sessionDir(cwd, sessionId), "claude-session");
}
/** Run one turn in Claude Code with Aegis's lock on every tool call. */
export async function runClaudeCodeTurn(input) {
    const started = Date.now();
    const bin = input.claudeBin ?? findClaude();
    if (!bin)
        throw new Error(CLAUDE_MISSING);
    const tools = [];
    const token = randomBytes(18).toString("hex");
    const guards = toolGuards(input.plugins);
    const jev = input.jev ?? scorerOf(input.plugins);
    // Claude Code may run tools in parallel; you still get one question at a time.
    const serial = serializeConfirm(input.confirm);
    // A question nobody answers becomes No before Claude Code's hook would time out (a timed-out hook does not block).
    const confirm = (question, options) => {
        let timer;
        const limit = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), APPROVAL_LIMIT_MS);
        });
        return Promise.race([serial(question, options), limit]).finally(() => clearTimeout(timer));
    };
    const dir = sessionDir(input.cwd, input.sessionId);
    const settingsFile = path.join(dir, "claude-settings.json");
    const appendFile = path.join(dir, "claude-append.md");
    const hookScript = path.join(packageRoot(), "scripts", "claude-hook.mjs");
    const protectedFiles = [settingsFile, appendFile, hookScript];
    const turnAbort = new AbortController();
    input.abortSignal?.addEventListener("abort", () => turnAbort.abort(), { once: true });
    // The lock: Claude Code's hook posts each tool call here; the same gate as Aegis's own tools answers.
    const server = createServer(async (req, res) => {
        const reply = (status, value) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(value));
        };
        if (req.method !== "POST" || req.headers["x-aegis-token"] !== token)
            return reply(401, { decision: "deny" });
        req.setEncoding("utf8");
        let body = "";
        for await (const chunk of req) {
            body += chunk;
            if (body.length > MAX_HOOK_BODY) {
                req.destroy();
                return;
            }
        }
        let call;
        try {
            call = JSON.parse(body);
        }
        catch {
            return reply(200, { decision: "deny", reason: "unreadable tool call" });
        }
        const tool = String(call.tool_name ?? "");
        if (HARMLESS.has(tool)) {
            if (tool === "TodoWrite")
                input.onEvent?.({ type: "todos", todos: cleanTodos(call.tool_input?.todos) });
            return reply(200, { decision: "allow", reason: "Claude Code bookkeeping" });
        }
        const mapped = toAegisCall(tool, call.tool_input ?? {});
        const target = toolTarget(mapped.name, mapped.args) || undefined;
        input.onEvent?.({ type: "tool_start", name: mapped.name, target });
        const refused = hardDeny(mapped.name, mapped.args, input.cwd, protectedFiles);
        if (refused) {
            const record = {
                name: mapped.name,
                class: "irreversible",
                dataLoss: 1,
                confidence: 1,
                action: "deny",
                approved: false,
                target,
                source: "agreement",
                deniedReason: refused,
            };
            tools.push(record);
            input.onEvent?.({ type: "tool", record });
            return reply(200, { decision: "deny", reason: `Aegis denied it: ${refused}. Do not retry this call.` });
        }
        try {
            const run = await runGatedTool({
                name: mapped.name,
                args: mapped.args,
                cwd: input.cwd,
                jev,
                config: input.config,
                confirm,
                abortSignal: turnAbort.signal,
                onEvent: input.onEvent,
                guards,
                readOnly: input.readOnly,
                // Claude Code runs the tool itself once Aegis says yes.
                execute: async () => "allowed",
            });
            tools.push(run.record);
            input.onEvent?.({ type: "tool", record: run.record });
            const allowed = run.record.approved && !turnAbort.signal.aborted;
            if (allowed && (mapped.name === "write" || mapped.name === "edit") && typeof mapped.args.path === "string") {
                await input.checkpoint?.(path.resolve(input.cwd, mapped.args.path));
            }
            return reply(200, {
                decision: allowed ? "allow" : "deny",
                reason: allowed
                    ? `Aegis: ${run.record.action === "auto" && run.record.rule ? `rule "${run.record.rule}"` : "you allowed it"}`
                    : `Aegis denied it: ${run.record.deniedReason ?? "not allowed"}. Do not retry this call.`,
            });
        }
        catch (error) {
            return reply(200, { decision: "deny", reason: `Aegis could not decide: ${error instanceof Error ? error.message : String(error)}` });
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await mkdir(dir, { recursive: true });
    await writeFile(settingsFile, JSON.stringify({
        // Your own ~/.claude settings cannot switch the lock off for this run, nor pre-approve around it.
        disableAllHooks: false,
        permissions: { defaultMode: "default" },
        hooks: {
            PreToolUse: [
                {
                    matcher: "*",
                    hooks: [
                        {
                            type: "command",
                            // Exec form: no shell parses these paths (Git Bash or PowerShell on Windows).
                            command: process.execPath,
                            args: [hookScript],
                            timeout: HOOK_TIMEOUT_S,
                        },
                    ],
                },
            ],
        },
    }, null, 2));
    const resume = await readFile(claudeSessionFile(input.cwd, input.sessionId), "utf8").then((text) => text.trim(), () => "");
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--settings", settingsFile];
    if (resume && /^[\w-]+$/.test(resume))
        args.push("--resume", resume);
    // A /fork copied the Claude conversation id: the first turn in the fork branches it (a new id), so the two
    // Aegis sessions never write into one Claude conversation.
    const forkMark = path.join(sessionDir(input.cwd, input.sessionId), "claude-fork");
    if (resume && existsSync(forkMark))
        args.push("--fork-session");
    if (input.readOnly)
        args.push("--permission-mode", "plan");
    if (input.appendSystem) {
        await writeFile(appendFile, input.appendSystem);
        args.push("--append-system-prompt-file", appendFile);
    }
    const shim = /\.(cmd|bat)$/i.test(bin);
    const child = spawn(shim ? `"${bin}"` : bin, shim ? args.map((arg) => `"${arg}"`) : args, {
        cwd: input.cwd,
        env: { ...process.env, ...NO_CWD_SEARCH_ENV, AEGIS_HOOK_URL: `http://127.0.0.1:${port}/`, AEGIS_HOOK_TOKEN: token },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: shim, // npm's claude.cmd can only be started through cmd; every argument above is quoted
    });
    const onAbort = () => {
        if (child.pid)
            killProcessTree(child.pid);
    };
    turnAbort.signal.addEventListener("abort", onAbort, { once: true });
    child.stdin.end(input.prompt);
    let answer = "";
    let result;
    let claudeSession = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    child.stdout.setEncoding("utf8");
    let buffer = "";
    const handle = (line) => {
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            return;
        }
        if (event.session_id)
            claudeSession = event.session_id;
        if (event.type === "system" && event.subtype === "init")
            input.onEvent?.({ type: "waiting_model" });
        if (event.type === "assistant") {
            for (const block of event.message?.content ?? []) {
                if (block.type === "text" && block.text) {
                    answer += (answer ? "\n\n" : "") + block.text;
                    input.onEvent?.({ type: "text_delta", text: block.text });
                }
                if (block.type === "thinking" && block.thinking)
                    input.onEvent?.({ type: "reasoning_delta", text: block.thinking });
            }
        }
        if (event.type === "result")
            result = event;
    };
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            if (line)
                handle(line);
        }
    });
    const exitCode = await new Promise((resolve) => {
        child.on("error", () => resolve(-1));
        child.on("close", (code) => resolve(code ?? -1));
    });
    if (buffer.trim())
        handle(buffer.trim());
    turnAbort.signal.removeEventListener("abort", onAbort);
    server.close();
    if (claudeSession && /^[\w-]+$/.test(claudeSession)) {
        await writeFile(claudeSessionFile(input.cwd, input.sessionId), claudeSession);
        if (claudeSession !== resume)
            await rm(forkMark, { force: true });
    }
    if (turnAbort.signal.aborted)
        throw new Error("cancelled");
    if (!result) {
        throw new Error(`Claude Code stopped without an answer (exit ${exitCode}). ${stderr.trim().split("\n").slice(-3).join(" ")}`.trim());
    }
    const finalText = (result.result ?? answer).trim();
    if (result.is_error)
        throw new Error(`Claude Code: ${finalText || result.subtype || "error"}`);
    const usage = result.usage ?? {};
    const receipt = {
        sessionId: input.sessionId,
        prompt: input.prompt,
        model: CLAUDE_CODE_MODEL,
        routeReason: "selected",
        turn: unscoredTurn(),
        tools,
        ms: Date.now() - started,
        millicents: 0,
        text: finalText,
        answer: finalText,
        finishReason: "stop",
        tokens: {
            input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            output: usage.output_tokens ?? 0,
        },
        newMessages: finalText ? [{ role: "assistant", content: finalText, at: new Date().toISOString() }] : [],
    };
    for (const plugin of input.plugins)
        await plugin.onReceipt?.(receipt, { cwd: input.cwd });
    return receipt;
}
