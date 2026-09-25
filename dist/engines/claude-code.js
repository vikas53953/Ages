/**
 * Claude Code as an engine: `/model claude-code` hands a turn to the real, unmodified Claude Code that you
 * signed in to with your own Claude plan (Anthropic permits exactly this). Aegis keeps the lock: Claude
 * Code calls scripts/claude-hook.mjs before every tool, the hook asks this process, and the same rules,
 * Jev and y/a/N approvals decide. If Aegis cannot answer, the hook blocks the call.
 *
 * Claude Code runs headless: `claude -p --output-format stream-json --verbose`, prompt on stdin,
 * `--resume` keeps one Claude conversation per Aegis session.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { packageRoot } from "../env.js";
import { killProcessTree } from "../exec.js";
import { serializeConfirm } from "../confirm-queue.js";
import { runGatedTool, toolTarget } from "../gated.js";
import { scorerOf, toolGuards } from "../plugin-api.js";
import { unscoredTurn } from "../router.js";
import { sessionDir } from "../session.js";
export const CLAUDE_CODE_MODEL = "claude-code";
/** Where `claude` is: AEGIS_CLAUDE_BIN, else the first `claude` on PATH. */
export function findClaude(env = process.env) {
    if (env.AEGIS_CLAUDE_BIN)
        return existsSync(env.AEGIS_CLAUDE_BIN) ? env.AEGIS_CLAUDE_BIN : undefined;
    const finder = process.platform === "win32" ? "where" : "which";
    const found = spawnSync(finder, ["claude"], { encoding: "utf8", windowsHide: true });
    if (found.status !== 0)
        return undefined;
    const lines = found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // On Windows prefer the real program (claude.exe) over npm's claude.cmd shim.
    return lines.find((line) => /\.exe$/i.test(line)) ?? lines.find((line) => /\.(cmd|bat)$/i.test(line)) ?? lines[0];
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
        case "Glob":
            return { name: "grep", args: { pattern: input.pattern, path: input.path ?? "." } };
        case "WebFetch":
            return { name: "webfetch", args: { command: String(input.url ?? "") } };
        default:
            return { name: tool.toLowerCase(), args: input };
    }
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
    const confirm = serializeConfirm(input.confirm);
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
        for await (const chunk of req)
            body += chunk;
        let call;
        try {
            call = JSON.parse(body);
        }
        catch {
            return reply(200, { decision: "deny", reason: "unreadable tool call" });
        }
        const tool = String(call.tool_name ?? "");
        if (HARMLESS.has(tool))
            return reply(200, { decision: "allow", reason: "Claude Code bookkeeping" });
        const mapped = toAegisCall(tool, call.tool_input ?? {});
        input.onEvent?.({ type: "tool_start", name: mapped.name, target: toolTarget(mapped.name, mapped.args) || undefined });
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
                // Claude Code runs the tool itself once Aegis says yes.
                execute: async () => "allowed",
            });
            tools.push(run.record);
            input.onEvent?.({ type: "tool", record: run.record });
            const allowed = run.record.approved && !turnAbort.signal.aborted;
            return reply(200, {
                decision: allowed ? "allow" : "deny",
                reason: allowed
                    ? `Aegis: ${run.record.rule ? `rule "${run.record.rule}"` : "you allowed it"}`
                    : `Aegis denied it: ${run.record.deniedReason ?? "not allowed"}. Do not retry this call.`,
            });
        }
        catch (error) {
            return reply(200, { decision: "deny", reason: `Aegis could not decide: ${error instanceof Error ? error.message : String(error)}` });
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const dir = sessionDir(input.cwd, input.sessionId);
    await mkdir(dir, { recursive: true });
    const settingsFile = path.join(dir, "claude-settings.json");
    await writeFile(settingsFile, JSON.stringify({
        hooks: {
            PreToolUse: [
                {
                    matcher: "*",
                    hooks: [
                        {
                            type: "command",
                            // Exec form: no shell parses these paths (Git Bash or PowerShell on Windows).
                            command: process.execPath,
                            args: [path.join(packageRoot(), "scripts", "claude-hook.mjs")],
                            timeout: 3600,
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
    if (input.appendSystem) {
        const appendFile = path.join(dir, "claude-append.md");
        await writeFile(appendFile, input.appendSystem);
        args.push("--append-system-prompt-file", appendFile);
    }
    const shim = /\.(cmd|bat)$/i.test(bin);
    const child = spawn(shim ? `"${bin}"` : bin, shim ? args.map((arg) => `"${arg}"`) : args, {
        cwd: input.cwd,
        env: { ...process.env, AEGIS_HOOK_URL: `http://127.0.0.1:${port}/`, AEGIS_HOOK_TOKEN: token },
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
    if (claudeSession && /^[\w-]+$/.test(claudeSession))
        await writeFile(claudeSessionFile(input.cwd, input.sessionId), claudeSession);
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
