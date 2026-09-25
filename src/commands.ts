export type Slash =
  | { type: "empty" }
  | { type: "help" }
  | { type: "exit" }
  | { type: "new" }
  | { type: "sessions" }
  | { type: "resume"; id: string }
  | { type: "memory"; note?: string }
  | { type: "skills" }
  | { type: "compact" }
  | { type: "clear" }
  | { type: "status" }
  | { type: "models" }
  | { type: "model"; id?: string }
  | { type: "unknown"; name: string }
  | { type: "prompt"; text: string };

export function isExactYes(text: string) {
  return /^(yes|y)$/i.test(text.trim());
}

export function parseLine(line: string): Slash {
  const text = line.trim();
  if (!text) return { type: "empty" };
  if (!text.startsWith("/")) return { type: "prompt", text };
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
  "  /memory            show memory",
  "  /memory <note>     remember a note",
  "  /skills            list loaded skills",
  "  /compact           fold old turns into a summary (also automatic when history is big)",
  "  /clear             start a new session",
  "  /models            list every available model",
  "  /model             show auto or pinned model",
  "  /model auto        Jev picks cheap vs frontier",
  "  /model <id>        pin a model (persists)",
  "  /status            provider, session, cwd, task",
  "  /exit              quit",
  "",
  "Anything else is a prompt to the agent.",
].join("\n");
