# Project map

Harness is our Pi-shaped coding-agent CLI. Jev decides. Code enforces. The model writes.

| Path | Plain-words job |
| --- | --- |
| `src/cli.ts` | Entry: TUI on a TTY, `--repl` for the old prompt |
| `src/tui.ts` | Full-screen terminal UI |
| `src/tui-layout.ts` | Header / log / prompt frame |
| `src/runtime.ts` | Slash commands + one turn, shared by TUI and REPL |
| `src/repl.ts` | Queue stdin lines so piped commands are not dropped |
| `src/commands.ts` | Parse /help /new /compact /status /exit |
| `src/session.ts` | Save and resume a conversation |
| `src/compact.ts` | Fold old turns into a summary |
| `src/memory.ts` | Notes the agent must keep |
| `src/skills.ts` | Load `skills/*.md` |
| `src/context.ts` | Load `AGENTS.md` / `HARNESS.md` |
| `src/system.ts` | Build the system prompt |
| `src/planner.ts` | No-key tool pick from the prompt |
| `src/providers.ts` | Local / OpenCode Zen / OpenAI |
| `src/loop.ts` | One turn: Jev → model → tools → receipt |
| `src/router.ts` | Cheap or frontier model id |
| `src/policy.ts` | Auto-run or ask first |
| `src/gated.ts` | Ask Jev about one tool, then run or refuse |
| `src/receipt.ts` | Print the stamp; save under `.harness/receipts` |
| `src/delivery.ts` | Task agreement, evidence, delivery card |
| `src/jev/` | Live Jev and mock Jev |
| `src/tools/` | read, write, edit, grep, shell |
| `AGENTS.md` | Project rules injected every turn |
| `skills/` | Markdown skills injected every turn |
| `.harness/` | Sessions, memory, receipts (not committed) |
