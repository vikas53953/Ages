/**
 * The startup screen. Layout follows Claude Code's welcome box (title in the border, welcome + mascot on the
 * left, tips and recent activity on the right) and Pi's one-line key hints underneath. The content is Aegis's own:
 * a shield, and the lock (rules, Jev, plugins) that every tool call passes.
 */
import os from "node:os";
import path from "node:path";
const ESC = "\x1b[";
function palette(color) {
    const wrap = (code) => (color ? (text) => `${ESC}${code}m${text}${ESC}0m` : (text) => text);
    return { accent: wrap("36"), strong: wrap("1;36"), bold: wrap("1"), dim: wrap("2") };
}
/** Visible width: ANSI colour codes take no room. Every character we draw is single-width. */
export function visibleWidth(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function fit(text, width) {
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    if (plain.length <= width)
        return text + " ".repeat(width - plain.length);
    return `${plain.slice(0, Math.max(0, width - 1))}…`;
}
function center(text, width) {
    const pad = Math.max(0, width - visibleWidth(text));
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + text + " ".repeat(pad - left);
}
/** ~\Projects\gate instead of C:\Users\vikasmit\Projects\gate; long paths keep their tail. */
export function shortPath(cwd, max, home = os.homedir()) {
    const rel = path.relative(home, cwd);
    const shown = rel === "" ? "~" : !rel.startsWith("..") && !path.isAbsolute(rel) ? `~${path.sep}${rel}` : cwd;
    return shown.length <= max ? shown : `…${shown.slice(shown.length - max + 1)}`;
}
/** The Aegis shield. Only full and half blocks, so Windows Terminal and the classic console both draw it. */
export const SHIELD = [
    "█▀▀▀▀▀▀▀█",
    "█  ▄█▄  █",
    "█ ▀▀█▀▀ █",
    "▀▄  █  ▄▀",
    "  ▀▄█▄▀  ",
];
export const KEY_HINTS = ["ctrl+c stop / exit", "/ commands", "shift+enter newline", "/login keys"];
function hintLine(width, paint) {
    const parts = [];
    for (const hint of KEY_HINTS) {
        const next = [...parts, hint].join(" · ");
        if (next.length + 2 > width)
            break;
        parts.push(hint);
    }
    return paint.dim(`  ${parts.join(" · ")}`);
}
function lockLines(info) {
    const { deny, ask, allow } = info.rules;
    return [
        `rules    ${deny} deny · ${ask} ask · ${allow} allow`,
        `jev      ${info.jevMode} · ${info.jevHealth}`,
        `plugins  ${info.plugins.length ? info.plugins.join(", ") : "none"}`,
    ];
}
function firstSteps(info) {
    return info.hasChatKey
        ? ["Type a task, or /help for commands", "Rules decide first: .aegis/settings.json"]
        : ["Connect a model: /login opencode <key>", "Until then: list, read and search only"];
}
/** Lines of the welcome screen for a terminal `cols` wide. */
export function welcomeLines(info, cols, color = true) {
    const paint = palette(color);
    const width = Math.min(Math.max(cols, 20), 104);
    const title = ` ${info.name} v${info.version} `;
    if (width < 44) {
        // Pi-sized: name, one hint, done.
        return [
            `${paint.strong(info.name)} ${paint.dim(`v${info.version}`)}`,
            paint.dim(`${info.model} · jev ${info.jevMode}`),
            paint.dim("/help commands · ctrl+c exit"),
            "",
        ];
    }
    const inner = width - 2;
    const top = paint.accent(`╭───${title}${"─".repeat(Math.max(0, inner - 3 - title.length))}╮`);
    const bottom = paint.accent(`╰${"─".repeat(inner)}╯`);
    const side = paint.accent("│");
    const row = (text) => `${side}${fit(text, inner)}${side}`;
    const modelLine = `${info.model} · ${info.provider}`;
    if (width < 78) {
        const body = [
            "",
            ` ${paint.bold(`Welcome back, ${info.user}!`)}`,
            ` ${paint.dim(modelLine)}`,
            ` ${paint.dim(shortPath(info.cwd, inner - 2))}`,
            "",
            ...firstSteps(info).map((line) => ` ${line}`),
            "",
            ...lockLines(info).map((line) => ` ${paint.dim(line)}`),
            "",
        ];
        return [top, ...body.map(row), bottom, hintLine(width, paint), ""];
    }
    const leftWidth = Math.floor(inner * 0.4);
    const rightWidth = inner - leftWidth - 1;
    const left = [
        "",
        center(paint.bold(`Welcome back, ${info.user}!`), leftWidth),
        "",
        ...SHIELD.map((line) => center(paint.accent(line), leftWidth)),
        "",
        center(paint.dim(fit(info.model, leftWidth - 2).trimEnd()), leftWidth),
        center(paint.dim(fit(info.provider, leftWidth - 2).trimEnd()), leftWidth),
        center(paint.dim(shortPath(info.cwd, leftWidth - 2)), leftWidth),
    ];
    const rule = paint.dim("─".repeat(rightWidth - 2));
    const recent = info.recent.length
        ? info.recent.slice(0, 3).map((item) => `${paint.dim(item.when)}  ${item.text}`)
        : [paint.dim("No recent sessions")];
    const right = [
        "",
        paint.strong("Getting started"),
        ...firstSteps(info),
        rule,
        paint.strong("The lock"),
        ...lockLines(info).map((line) => paint.dim(line)),
        rule,
        paint.strong("Recent sessions"),
        ...recent,
    ];
    const height = Math.max(left.length, right.length) + 1;
    const rows = [];
    for (let i = 0; i < height; i++) {
        const l = fit(left[i] ?? "", leftWidth);
        const r = fit(` ${right[i] ?? ""}`, rightWidth);
        rows.push(`${side}${l}${side}${r}${side}`);
    }
    // The column divider is part of the left cell's right edge.
    return [top, ...rows, bottom, hintLine(width, paint), ""];
}
