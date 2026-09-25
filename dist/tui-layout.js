export const ACCENT = "\x1b[36m";
export const MUTED = "\x1b[2m";
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
    return wrapLine(text, wrapAt).map((line, index) => (index === 0 ? `${ACCENT}›${RESET} ${line}` : `  ${line}`));
}
const DOT = {
    pending: "\x1b[33m●\x1b[0m",
    ran: "\x1b[32m●\x1b[0m",
    denied: "\x1b[31m●\x1b[0m",
};
/** "● read README.md   rule read *" — one line per tool call, dot coloured by what happened. */
export function renderToolLine(item, cols) {
    const head = `${DOT[item.status]} ${item.text}`;
    const detail = item.detail ? `${MUTED}${item.detail}${RESET}` : "";
    const lines = wrapLine(item.text, Math.max(8, cols - 4)).map((line, index) => index === 0 ? `${DOT[item.status]} ${line}` : `  ${line}`);
    if (!detail)
        return lines.length ? lines : [head];
    return [...lines, ...wrapLine(item.detail, Math.max(8, cols - 6)).map((line) => `  ${MUTED}└ ${line}${RESET}`)];
}
export function renderAssistantMessage(text, cols) {
    return wrapLine(text, Math.max(1, cols - 3)).map((line) => `  ${line}`);
}
export function renderSystemMessage(text, cols) {
    return wrapLine(text, Math.max(1, cols - 3)).map((line) => `${MUTED}  ${line}${RESET}`);
}
export function jevStatus(mockJev, hasKey, healthy) {
    if (mockJev)
        return "mock";
    if (!hasKey)
        return "blocked";
    return healthy ? "live" : "down";
}
export function footerText(input) {
    const model = input.modelMode === "auto" ? "auto" : input.model;
    const task = `task ${input.task ?? "none"}`;
    const place = input.cwd ? `${input.cwd} · ` : "";
    if (input.busy) {
        const elapsed = Math.max(0, Math.floor((input.elapsedMs ?? 0) / 1000));
        const phase = input.phase ?? "working";
        return `${place}${model} · jev ${input.jev} · ${task} · ${phase}  ${elapsed}s`;
    }
    return `${place}${model} · jev ${input.jev} · ${input.provider} · ${task} · idle`;
}
/** One compact line after each turn, in place of the full handoff card the REPL prints. */
export function turnStatusLines(receipt) {
    const seconds = `${(receipt.ms / 1000).toFixed(1)}s`;
    const tools = receipt.tools.length ? `${receipt.tools.length} tool${receipt.tools.length === 1 ? "" : "s"}` : "no tools";
    const changed = receipt.tools
        .filter((tool) => tool.approved && (tool.name === "write" || tool.name === "edit"))
        .map((tool) => tool.target ?? tool.name);
    const outcome = receipt.outcome ?? "completed";
    const head = outcome === "completed"
        ? `✓ done · ${tools} · ${seconds} · ${receipt.model}`
        : outcome === "blocked"
            ? `⚠ blocked · ${tools} · ${seconds}`
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
