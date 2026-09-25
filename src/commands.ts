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
  | { type: "jev"; mode?: string }
  | { type: "models" }
  | { type: "model"; id?: string }
  | { type: "task"; action?: "confirm" | "accept" | "new" | "build" | "open"; id?: string; fingerprint?: string }
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
    case "jev":
      return { type: "jev", mode: arg || undefined };
    case "models":
      return { type: "models" };
    case "model":
      return { type: "model", id: arg || undefined };
    case "task":
    case "card":
    case "delivery":
      if (!arg) return { type: "task" };
      if (/^new$/i.test(arg)) return { type: "task", action: "new" };
      if (/^new\s+/i.test(arg)) return { type: "task", action: "new", id: arg.slice(4).trim() };
      if (/^confirm$/i.test(arg)) return { type: "task", action: "confirm" };
      if (/^confirm\s+/i.test(arg)) {
        const parts = arg.slice(8).trim().split(/\s+/);
        return { type: "task", action: "confirm", id: parts[0], fingerprint: parts[1] };
      }
      if (/^accept$/i.test(arg)) return { type: "task", action: "accept" };
      if (/^build$/i.test(arg)) return { type: "task", action: "build" };
      if (/^open$/i.test(arg)) return { type: "task", action: "open" };
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
  "  /status            provider, session, cwd, task",
  "  /jev               show Jev mode and key",
  "  /jev off|second|every  set Jev mode in .aegis/settings.json",
  "  /task              active task, pending confirm, delivery card",
  "  /task new <id>     next message proposes that task; does not overwrite others",
  "  /task confirm      confirm the displayed pending agreement, or active if none",
  "  /task confirm <id> <hash>  confirm that exact version only",
  "  /task accept       owner accepts delivery (explicit)",
  "  /task build        run the delivery loop for the confirmed inventory task",
  "  /task open         open the tested result if evidence is still bound",
  "  /exit              quit",
  "",
  "Anything else is a prompt to the agent.",
].join("\n");
