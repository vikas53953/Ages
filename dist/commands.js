export function isExactYes(text) {
    return /^(yes|y)$/i.test(text.trim());
}
export function parseLine(line) {
    const text = line.trim();
    if (!text)
        return { type: "empty" };
    if (!text.startsWith("/"))
        return { type: "prompt", text };
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd.toLowerCase()) {
        case "help":
        case "h":
            return { type: "help" };
        case "exit":
        case "quit":
        case "q":
            return { type: "exit" };
        case "new":
            return { type: "new" };
        case "sessions":
        case "ls":
            return { type: "sessions" };
        case "resume":
        case "open":
            return { type: "resume", id: arg };
        case "memory":
        case "mem":
            return { type: "memory", note: arg || undefined };
        case "skills":
            return { type: "skills" };
        case "compact":
            return { type: "compact" };
        case "rewind":
        case "undo":
            return { type: "rewind", arg: rest[0], what: rest[1]?.toLowerCase() };
        case "clear":
            return { type: "clear" };
        case "status":
            return { type: "status" };
        case "theme":
            return { type: "theme", name: arg || undefined };
        case "think":
        case "thinking":
            return { type: "think", arg: arg || undefined };
        case "login": {
            const [provider, key] = rest;
            return { type: "login", provider: provider?.toLowerCase(), key };
        }
        case "logout":
            return { type: "logout", provider: rest[0]?.toLowerCase() };
        case "models":
            return { type: "models" };
        case "model":
            return { type: "model", id: arg || undefined };
        default:
            return { type: "unknown", name: cmd };
    }
}
export const HELP = [
    "aegis — the agent you own. Rules decide first; plugins add the rest.",
    "",
    "  /help              this list",
    "  /new               start a new session",
    "  /sessions          list sessions",
    "  /resume <id>       continue a session",
    "  /memory            show memory notes",
    "  /memory <note>     remember a note",
    "  /skills            list loaded skills",
    "  /compact           fold old turns into a summary (also automatic when history is big)",
    "  /clear             start a new session",
    "  /models            list every available model",
    "  /model             show the model; pin one or go back to auto",
    "  /model auto        Jev picks cheap vs frontier",
    "  /model <id>        pin a model (persists); /model alone opens the picker",
    "  /think             show the thinking level and how reasoning is shown",
    "  /think off|low|medium|high  how hard the model thinks (saved per project)",
    "  /think fold|show|hide       reasoning folded (ctrl+t opens), shown live, or hidden",
    "  /status            provider, session, cwd, task",
    "  /theme aegis|light|contrast  colours (saved for you, every folder)",
    "  /login             show sign-ins and keys; /login opencode <key> saves one for every folder",
    "  /login chatgpt     sign in with your ChatGPT plan (add 'browser' to use this PC's browser)",
    "  /rewind            list restore points; /rewind 1 puts files and chat back to before that turn (add files or chat for just one)",
    "  /logout <name>     remove a saved key",
    "  /exit              quit",
    "",
    "Anything else is a prompt to the agent.",
].join("\n");
/**
 * "/model <id>        pin a model" → { name: "model", argumentHint: "<id>", description: "pin a model" }.
 * The TUI's / autocomplete is built from the same help lines as /help, so the two never disagree.
 */
export function slashCommandsFromHelp(lines) {
    const seen = new Map();
    for (const line of lines) {
        const match = /^\s*\/([\w-]+)((?:\s\S+)*?)\s{2,}(\S.*)$/.exec(line);
        if (!match)
            continue;
        const [, name, args, description] = match;
        const hint = args?.trim() ?? "";
        const entry = seen.get(name) ?? { name: name, description: description.trim(), hints: [], bare: false };
        if (hint && !entry.hints.includes(hint))
            entry.hints.push(hint);
        if (!hint)
            entry.bare = true;
        seen.set(name, entry);
    }
    // "/model", "/model auto", "/model <id>" → hint "[auto|<id>]" (optional because a bare /model also works).
    return [...seen.values()].map(({ name, description, hints, bare }) => {
        const joined = hints.join("|");
        const argumentHint = !hints.length ? undefined : bare ? `[${joined}]` : joined;
        return { name, description, argumentHint };
    });
}
