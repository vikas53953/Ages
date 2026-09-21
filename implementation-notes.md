# Implementation notes

- User-facing name is Harness. Jev stays the spend/danger lock inside the loop.
- Chat provider prefers OPENCODE_API_KEY (Zen `https://opencode.ai/zen/v1`). No key required to keep building: local tools + session still work.
- Receipts moved from `.gate/sessions` to `.harness/receipts`.
- Default OpenCode models: cheap `glm-5.3-flash`, frontier `glm-5.3` (chat-completions compatible). Override with GATE_CHEAP_MODEL / GATE_FRONTIER_MODEL.
- Pi-shaped V1.1: edit tool, /compact /clear /status, AGENTS.md context. No TUI, no session tree, no extension SDK — those stay later. Jev stays the lock.
- TUI V1: ANSI alternate screen, header, log, harness> input, y/N in the TUI. `--repl` keeps the plain prompt. No themes/extensions.
