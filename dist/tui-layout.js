import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatTokenLine } from "./receipt.js";
import { on, paint } from "./theme.js";
export const RESET = "\x1b[0m";
export function stripAnsi(text) {
    return sanitizeText(text);
}
export function sanitizeText(text) {
    return text
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b[_P^][^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[\?\d;]*[ -/]*[@-~]/g, "")
        .replace(/\x1b./g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
/** Text from outside (the model, a file, a path) as one safe line: no escape codes, no line breaks. */
export function oneLine(text) {
    return sanitizeText(text.replace(/[\r\n]+/g, " "));
}
export function wrapLine(text, width) {
    const cols = Math.max(1, width);
    const source = sanitizeText(text).replace(/\t/g, "  ").split(/\r?\n/);
    const out = [];
    for (const raw of source) {
        if (!raw) {
            out.push("");
            continue;
        }
        for (let i = 0; i < raw.length; i += cols) {
            out.push(raw.slice(i, i + cols));
        }
    }
    return out.length ? out : [""];
}
export function welcomeBanner(input) {
    return [
        `${input.name}  v${input.version}`,
        `${input.tagline ?? "the agent you own"}. ${input.difference ?? "Jev locks spend and danger."}`,
    ].join("\n");
}
export function renderUserMessage(text, cols) {
    const wrapAt = Math.max(8, cols - 3);
    return wrapLine(text, wrapAt).map((line, index) => (index === 0 ? `${on("accent")}›${RESET} ${line}` : `  ${line}`));
}
const DOT_ROLE = { drafting: "dim", pending: "warn", ran: "ok", denied: "err" };
const dot = (status) => paint(DOT_ROLE[status], "●");
/** Plain bold, in every theme (Claude Code's tool names). */
const bold = (text) => `\x1b[1m${text}${RESET}`;
/** Claude Code's names for what a tool does. */
const TOOL_LABEL = {
    read: "Read",
    write: "Write",
    edit: "Edit",
    grep: "Search",
    glob: "Find",
    shell: "Shell",
    webfetch: "Fetch",
    websearch: "Web search",
    explore: "Explore",
    agent: "Agent",
    skill: "Skill",
    remember: "Remember",
    todo: "Todos",
};
/** "Write(src/App.jsx)", "List(.)", "Search(runLoop)": what a tool line is called. */
export function toolTitle(name, target) {
    const listing = name === "read" && (target === undefined || target === "." || /[\\/]$/.test(target));
    const label = listing ? "List" : (TOOL_LABEL[name] ?? name);
    return target ? `${label}(${target})` : label;
}
/**
 * One tool call in the transcript, like Claude Code:
 *   ● Write(src/App.jsx)
 *     ⎿  Created · 9 lines
 *        1 import App from "./App";
 */
export function renderToolLine(item, cols) {
    const [first = "", ...rest] = wrapLine(item.text, Math.max(8, cols - 4));
    const lines = [`${dot(item.status)} ${bold(first)}`, ...rest.map((line) => `  ${bold(line)}`)];
    if (item.detail) {
        wrapLine(item.detail, Math.max(8, cols - 7)).forEach((line, index) => lines.push(index === 0 ? `  ${on("dim")}⎿${RESET}  ${line}` : `     ${line}`));
    }
    for (const line of item.body ?? []) {
        // A preview line is cut at the edge, never wrapped: it is a glimpse, not the file.
        const text = sanitizeText(line).replace(/\t/g, "  ");
        lines.push(`     ${on("dim")}${text.length > cols - 6 ? `${text.slice(0, Math.max(1, cols - 7))}…` : text}${RESET}`);
    }
    return lines;
}
export function renderAssistantMessage(text, cols) {
    return wrapLine(text, Math.max(1, cols - 3)).map((line) => `  ${line}`);
}
export function renderSystemMessage(text, cols) {
    return wrapLine(text, Math.max(1, cols - 3)).map((line) => `${on("dim")}  ${line}${RESET}`);
}
export function jevStatus(mockJev, hasKey, healthy) {
    if (mockJev)
        return "mock";
    if (!hasKey)
        return "blocked";
    return healthy ? "live" : "down";
}
export function footerText(input) {
    // Mode tags lead the footer (a long path must never push them off), and both show when both are on.
    const tag = `${input.plan ? "PLAN · " : ""}${input.mode === "yolo" ? `${paint("err", "YOLO")} · ` : input.mode === "auto" ? "AUTO · " : ""}`;
    const model = input.modelMode === "auto" ? "auto" : input.model;
    const task = `task ${input.task ?? "none"}`;
    const place = input.cwd ? `${input.cwd}${input.branch ? ` (${input.branch})` : ""} · ` : "";
    const extra = `${input.think ? ` · think ${input.think}` : ""}${input.tokens ? ` · ${input.tokens}` : ""}${input.context !== undefined ? ` · ctx ${input.context}%` : ""}`;
    if (input.busy) {
        const elapsed = Math.max(0, Math.floor((input.elapsedMs ?? 0) / 1000));
        const phase = input.phase ?? "working";
        // While busy, what is happening comes first so a narrow terminal never cuts it off.
        return `${tag}${phase}  ${elapsed}s · ${place}${model} · jev ${input.jev}${extra} · ${task}`;
    }
    return `${tag}${place}${model} · jev ${input.jev} · ${input.provider}${extra} · ${task} · idle`;
}
/** One compact line after each turn, in place of the full handoff card the REPL prints. */
export function turnStatusLines(receipt) {
    const seconds = `${(receipt.ms / 1000).toFixed(1)}s`;
    const tokenText = formatTokenLine(receipt.tokens);
    const tokenPart = tokenText ? ` · ${tokenText}` : "";
    const tools = receipt.tools.length ? `${receipt.tools.length} tool${receipt.tools.length === 1 ? "" : "s"}` : "no tools";
    const changed = receipt.tools
        .filter((tool) => tool.approved && (tool.name === "write" || tool.name === "edit"))
        .map((tool) => tool.target ?? tool.name);
    const outcome = receipt.outcome ?? "completed";
    const head = outcome === "completed"
        ? `✓ done · ${tools}${tokenPart} · ${seconds} · ${receipt.model}`
        : outcome === "blocked"
            ? `⚠ blocked · ${tools}${tokenPart} · ${seconds}`
            : outcome === "cancelled"
                ? `✗ cancelled · ${seconds}`
                : `… incomplete · finish=${receipt.finishReason ?? "?"} · ${receipt.steps ?? 0} steps · ${seconds}`;
    const lines = [head];
    if (changed.length)
        lines.push(`changed ${[...new Set(changed)].join(", ")}`);
    const blocked = /^Blocked {2}(.*)$/m.exec(receipt.text)?.[1];
    if (blocked)
        lines.push(`blocked ${blocked}`);
    const next = /^Next {2}(.*)$/m.exec(receipt.text)?.[1];
    if (next && (outcome !== "completed" || receipt.taskId))
        lines.push(`next    ${next}`);
    return lines;
}
/** The line under a tool call: what happened, in plain words ("Created · 381 lines", "You said no"). */
export function toolOutcome(record) {
    if (!record.approved) {
        const reason = record.deniedReason ?? "";
        if (reason === "user declined")
            return "You said no";
        if (reason === "cancelled")
            return "Stopped";
        if (reason.startsWith("rule: "))
            return `Blocked by your rule "${reason.slice(6)}"`;
        if (reason.startsWith("hook: "))
            return `Blocked by a hook: ${reason.slice(6)}`;
        return `Not allowed: ${reason || "no reason given"}`;
    }
    const parts = [record.summary ?? "Done"];
    // Ran without a question because of the session mode: said once per line, so it is never silent.
    if (record.mode === "auto")
        parts.push("auto mode");
    else if (record.mode === "yolo")
        parts.push("YOLO");
    if (record.savedRule)
        parts.push(`won't ask again (${record.savedRule})`);
    else if (record.saveFailed)
        parts.push(`rule not saved: ${record.saveFailed}`);
    if (record.via)
        parts.push(`by agent ${record.via}`);
    if (record.redacted)
        parts.push(`${record.redacted} secret${record.redacted === 1 ? "" : "s"} hidden from the model`);
    return parts.join(" · ");
}
/** "9.9s", "2m 40s". */
export function formatDuration(ms) {
    const seconds = Math.round(ms / 100) / 10;
    if (seconds < 60)
        return `${seconds.toFixed(1)}s`;
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}
/** A path the terminal opens on ctrl+click (an OSC 8 link; Windows Terminal, VS Code, iTerm2 and others follow it). */
export function fileLink(absolute) {
    const shown = oneLine(absolute);
    // A path with control characters (possible on Linux) is shown cleaned and not linked: what you click is what you see.
    if (shown !== absolute)
        return shown;
    return `\x1b]8;;${pathToFileURL(absolute).href}\x07${absolute}\x1b]8;;\x07`;
}
/**
 * The end of a turn in the terminal: how it ended and how long it took, then the full path of every file it created
 * or changed (ctrl+click opens one), then the model and tokens, quietly. Answers "where is it?" before it is asked.
 */
export function turnEndLines(receipt, cwd) {
    const took = formatDuration(receipt.ms);
    const files = new Map();
    for (const tool of receipt.tools) {
        if (!tool.approved || !tool.target || (tool.name !== "write" && tool.name !== "edit"))
            continue;
        // "a.ts" and "./a.ts" are one file.
        const file = path.normalize(tool.target);
        files.set(file, Boolean(files.get(file) || tool.created));
    }
    const created = [...files.values()].filter(Boolean).length;
    const changed = files.size - created;
    const counts = [created ? `created ${created} file${created === 1 ? "" : "s"}` : "", changed ? `changed ${changed} file${changed === 1 ? "" : "s"}` : ""]
        .filter(Boolean)
        .join(", ");
    const outcome = receipt.outcome ?? "completed";
    const head = outcome === "completed"
        ? `${paint("ok", "✓")} Done in ${took}${counts ? ` · ${counts}` : ""}`
        : outcome === "blocked"
            ? `${paint("warn", "⚠")} Blocked after ${took}${counts ? ` · ${counts}` : ""}`
            : outcome === "cancelled"
                ? `${paint("err", "✗")} Stopped after ${took}${counts ? ` · ${counts}` : ""}`
                : `${paint("warn", "…")} Stopped early (${oneLine(receipt.finishReason ?? "step limit")}) after ${took}${counts ? ` · ${counts}` : ""}`;
    const lines = [`  ${head}`];
    for (const file of files.keys())
        lines.push(`    ${on("accent")}${fileLink(path.resolve(cwd, file))}${RESET}`);
    // What blocked the turn comes from the lock's own records, never from the text (which ends with the model's answer).
    const blocked = receipt.tools.find((tool) => !tool.approved && tool.source === "agreement")?.deniedReason;
    if (blocked)
        lines.push(`    blocked: ${oneLine(blocked)}`);
    const next = /^Next {2}(.*)$/m.exec(receipt.text)?.[1];
    if (next && (outcome !== "completed" || receipt.taskId))
        lines.push(`    next: ${oneLine(next)}`);
    const tokens = formatTokenLine(receipt.tokens);
    const quiet = [files.size ? "ctrl+click a path to open it" : "", oneLine(receipt.model), tokens].filter(Boolean).join(" · ");
    lines.push(`    ${on("dim")}${quiet}${RESET}`);
    return lines;
}
/** Reasoning in the transcript: folded to one line (default), shown in full, or not at all. */
export function renderThinking(item, display, cols) {
    if (display === "hide")
        return [];
    const seconds = Math.max(1, Math.round(((item.endedAt ?? Date.now()) - item.startedAt) / 1000));
    const head = item.endedAt ? `Thought for ${seconds}s` : `Thinking… ${seconds}s`;
    if (display === "fold")
        return [`${on("dim")}▸ ${head} · ctrl+t to open${RESET}`];
    const body = wrapLine(item.text.trim(), Math.max(8, cols - 4)).map((line) => `${on("dim")}${on("italic")}  ${line}${RESET}`);
    return [`${on("dim")}▾ ${head} · ctrl+t to fold${RESET}`, ...body];
}
