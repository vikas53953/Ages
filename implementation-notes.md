# Implementation notes

- User-facing name is Harness. Jev stays the spend/danger lock inside the loop.
- Chat provider prefers OPENCODE_API_KEY (Zen `https://opencode.ai/zen/v1`). No key required to keep building: local tools + session still work.
- Receipts moved from `.gate/sessions` to `.harness/receipts`.
- Default OpenCode models: cheap `glm-5.3-flash`, frontier `glm-5.3` (chat-completions compatible). Override with GATE_CHEAP_MODEL / GATE_FRONTIER_MODEL.
- Pi-shaped V1.1: edit tool, /compact /clear /status, AGENTS.md context. No TUI, no session tree, no extension SDK — those stay later. Jev stays the lock.
- TUI V1: ANSI alternate screen, header, log, harness> input, y/N in the TUI. `--repl` keeps the plain prompt. No themes/extensions.
- Slice 1 (25 Sep 2026): rules before Jev. Order: agreement block → deny/ask/allow rules → Jev (off / second-opinion / every-call) → you (default n). Jev failing now means "ask", not "deny".
- Deviation from the agreed defaults: write, edit and ordinary shell have no default *ask* rule. They are "grey zone": Jev decides when it is on (today's behaviour with a key), otherwise you are asked. An explicit ask rule for them would make second-opinion mode do nothing by default. Dangerous shell (Remove-Item, git push, …) does have ask rules.
- Shell allow rules never match a chained or redirected command (; & | ` > < $( ); deny/ask rules match any piece of a chain.
- Unreadable settings: Jev off, allow rules ignored, deny/ask kept; a notice says so.
- Slice 2: the session now stores the model's real messages (assistant text + tool calls, then tool results), not the receipt card. Tool results are capped at 8,000 characters when saved. Old text-only sessions still load.
- AI SDK v7 detail: `result.response.messages` holds only the last step; the turn's messages are collected from every step (`steps[].response.messages`).
- Slice 3: compaction is core. Before a turn, if saved history is over `compactAtChars` (120,000 chars, about 30k tokens) the old turns are summarized by the cheap model into `.harness/sessions/<id>/summary.md`; the last `compactKeepTurns` (3) user turns stay word for word. The summary goes into the system prompt, not a fake message. The cut is always at a user turn so tool call/result pairs stay together. No model (local) or model error: the line-by-line summary is used and the notice says so.
