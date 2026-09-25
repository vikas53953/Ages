# Project map

Aegis is our Pi-shaped coding-agent CLI. Two layers: a small **core** (layer 0) and **plugins** (layer 1).
Rules decide first. Plugins add the rest. The model writes.

## Layer 0 — core (`src/`)

| Path | Plain-words job |
| --- | --- |
| `src/main.ts` | The installed `aegis` command (compiled to `dist/main.js`) |
| `src/cli.ts` | Flags (`--version`, `--repl`, `--local`, …); TUI on a TTY, plain prompt otherwise |
| `src/welcome.ts` | Startup screen: Claude-Code-style box (welcome, shield, the lock, recent sessions) + Pi-style key hints |
| `src/login.ts` | `/login` `/logout`: keys saved once in `~/.aegis/.env` |
| `src/tui.ts`, `src/tui-app.ts`, `src/tui-layout.ts` | Full-screen terminal UI: transcript, composer, footer, y/a/N pop-up, folded reasoning |
| `src/tui-model-picker.ts` | `/model` picker overlay (type to filter, exact id ranked first) |
| `src/tui-confirm.ts`, `src/confirm-queue.ts` | The y / a (always) / N box; one question at a time |
| `src/thinking.ts` | Thinking level (off/low/medium/high) and reasoning display (fold/show/hide) → provider options |
| `src/theme.ts` | Terminal colour themes (aegis, light, contrast), saved in `~/.aegis/settings.json` |
| `src/studio.ts` + `studio/` | **Aegis Studio** (`aegis ui`): local web server (127.0.0.1, key + Host check, strict CSP) and the page; drives `handleLine` like the TUI |
| `src/runtime.ts` | App shell: loads plugins from settings, runs slash commands, runs one prompt |
| `src/repl.ts` | Queue stdin lines so piped commands are not dropped |
| `src/commands.ts` | Parse core commands: /help /new /sessions /resume /memory /skills /compact /clear /models /model /think /theme /login /logout /status /exit |
| `src/loop.ts` | One turn: scorer route → model → tools → turn-end hooks |
| `src/router.ts` | Cheap or frontier model from a turn score; `unscoredTurn` when nothing scores |
| `src/providers.ts` | Local / OpenCode Zen / OpenAI model connection |
| `src/tools/` | read, write, edit, grep, shell (PowerShell, off unless `AEGIS_ALLOW_SHELL=1`) |
| `src/gated.ts` | The checkpoint every tool passes: plugin guards → rules → scorer (if on) → you → run |
| `src/rules.ts` | Read `.aegis/settings.json`: rules, Jev mode, plugin list, thinking; which "always allow" rule to offer and saving it |
| `src/policy.ts` | Turn a score into run or ask; `stricter()` lets a scorer only tighten |
| `src/checkpoints.ts` | Restore points before each approved write/edit (Aegis's tools and Claude Code's); `/rewind` |
| `src/session.ts` | Save and resume a conversation, tool calls and results included |
| `src/compact.ts` | Fold old turns into `summary.md` (model-written, line-by-line fallback); automatic when history is big |
| `src/system.ts` | Build the system prompt (AGENTS.md, summary, memory, skills) |
| `src/memory.ts`, `src/skills.ts`, `src/context.ts` | Memory notes, `skills/*.md`, `AGENTS.md` |
| `src/receipt.ts` | Format the end-of-turn handoff and receipt text |
| `src/health.ts` | Jev status shown in the footer and /status |
| `src/plugin-api.ts` | **The contract between core and plugins**: every hook a plugin can use |

## Layer 1 — plugins (`src/plugins/`)

Loaded by name from `"plugins"` in `.aegis/settings.json`. Remove a name and that behaviour is gone; the core still runs.

| Plugin | Hooks it uses | Job |
| --- | --- | --- |
| `jev` (`src/plugins/jev/`) | scorer, `/jev` | Scores turns (cheap vs frontier) and grey-zone tool calls |
| `delivery` (`src/plugins/delivery/`) | guardTool, systemPrompt, beforePrompt, beforeTurn, turnEnd, `/task` | Task agreement, evidence, delivery card, device-inventory builder |
| `receipts` (`src/plugins/receipts.ts`) | onReceipt | Saves each turn's receipt to `.harness/receipts` |
| `src/plugins/index.ts` | — | Registry: name → plugin |

## Files you edit

| Path | Job |
| --- | --- |
| `.aegis/settings.json` | Your rules, Jev mode and plugin list (committed) |
| `AGENTS.md` | Project rules injected every turn |
| `skills/` | Markdown skills injected every turn |
| `gate.config.json` | Models, thresholds, `compactAtChars`, `compactKeepTurns` |
| `~/.aegis/.env` | Your API keys for every folder (written by `/login`) |
| `install.ps1`, `install.sh` | One-line installers (Windows / Linux, macOS, cloud) |
| `.harness/` | Sessions, summaries, memory, receipts, task records (not committed) |
