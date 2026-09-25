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
            return { type: "skills", action: rest[0]?.toLowerCase() };
        case "compact":
            return { type: "compact" };
        case "doctor":
            return { type: "doctor" };
        case "init":
            return { type: "init" };
        case "fork":
        case "branch":
            return { type: "fork", arg: rest[0] };
        case "trust":
            return { type: "trust", action: rest[0]?.toLowerCase() };
        case "diff":
            return { type: "diff", arg };
        case "rules":
        case "permissions":
            return { type: "rules", arg };
        case "todos":
        case "todo":
            return { type: "todos" };
        case "export":
            return { type: "export", format: rest[0]?.toLowerCase() };
        case "copy":
            return { type: "copy" };
        case "review":
            return { type: "review", arg: rest.join(" ") };
        case "mcp":
            return { type: "mcp", action: rest[0]?.toLowerCase(), name: rest[1] };
        case "plan":
            return { type: "plan", arg: rest.join(" ").trim() || undefined };
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
    "  /sessions          your recent conversations, numbered, with their first prompt",
    "  /resume <n>        continue conversation n from /sessions (or /resume <id>); /resume alone lists them",
    "  /memory            show memory notes",
    "  /memory <note>     remember a note",
    "  /skills            skills and custom commands (yours, and this project's once you /skills trust them)",
    "  /skill:<name>      use a skill now (add what to do after it)",
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
    "  /review            review uncommitted changes (read-only); /review main · /review commit <sha> · add notes",
    "  /copy              copy the last answer to the clipboard",
    "  /export            save this conversation to .harness/exports (md, or jsonl with every tool call)",
    "  /todos             the agent's todo list for this session (shown above the prompt while work is open)",
    "  /init              let the agent write a first AGENTS.md for this project (you approve the write)",
    "  /fork              copy this conversation into a new session and continue there; /fork 1 leaves out your last turn (try it another way)",
    "  /rules             every rule the lock uses and where it comes from; /rules <word> filters",
    "  /rules remove <n>  remove one of your saved rules (an 'always allow' you gave); /rules deny|ask <rule> adds a stricter one",
    "  /trust             review this folder's .aegis/settings.json; /trust yes uses its allow rules and plugins; /trust off",
    "  /doctor            is this PC ready? checks Node, sign-ins, engine, rules, shell, MCP, terminal",
    "  /mcp               MCP servers and their tools; /mcp trust <name> allows a project's server; /mcp restart",
    "  /plan              plan mode: read-only until you approve; /plan go carries it out, /plan off leaves",
    "  /diff              what the agent changed in this session (each file against how it was before); /diff stat · /diff <file>",
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
        const match = /^\s*\/([\w:-]+)((?:\s\S+)*?)\s{2,}(\S.*)$/.exec(line);
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
