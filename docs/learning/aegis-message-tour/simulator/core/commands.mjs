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
        case "clear":
            return { type: "clear" };
        case "status":
            return { type: "status" };
        case "models":
            return { type: "models" };
        case "model":
            return { type: "model", id: arg || undefined };
        case "task":
        case "card":
        case "delivery":
            if (!arg)
                return { type: "task" };
            if (/^confirm$/i.test(arg))
                return { type: "task", action: "confirm" };
            if (/^accept$/i.test(arg))
                return { type: "task", action: "accept" };
            return { type: "prompt", text };
        default:
            return { type: "prompt", text };
    }
}
export const HELP = [
    "aegis — the agent you own. Jev locks spend and danger.",
    "",
    "  /help              this list",
    "  /new               start a new session",
    "  /sessions          list sessions",
    "  /resume <id>       continue a session",
    "  /memory            show memory",
    "  /memory <note>     remember a note",
    "  /skills            list loaded skills",
    "  /compact           fold old turns into a summary",
    "  /clear             start a new session",
    "  /models            list every available model",
    "  /model             show auto or pinned model",
    "  /model auto        Jev picks cheap vs frontier",
    "  /model <id>        pin a model (persists)",
    "  /status            provider, session, cwd",
    "  /task              delivery card for the current task",
    "  /task confirm      owner confirms the agreement",
    "  /task accept       owner accepts delivery (explicit)",
    "  /exit              quit",
    "",
    "Anything else is a prompt to the agent.",
].join("\n");
