# Aegis vs Claude Code, Codex CLI, Pi and OpenCode

Written 25 Sep 2026 from README.md, PROJECT-MAP.md and implementation-notes.md. Other tools are from memory as of 2026; ⚠️ "unverified" means I am not sure of the current state.

## Summary

1. Aegis is ahead on the lock: rules first, hooks that can only tighten, project trust by hash, secret redaction at the gate, and shell off by default. No reference tool ships all of this.
2. Aegis is ahead on Windows: PowerShell, CRLF edits, 8.3 paths, `icacls`, System32-only lookups. The others treat Windows as second or third.
3. Aegis is behind on models: no first-party Claude or Gemini plan sign-in, and the Claude route depends on running Claude Code as an engine.
4. Aegis is behind on OS sandboxing (Claude Code, Codex). (websearch, HTTP MCP and custom agents were added the same night.)
5. Aegis is behind on ecosystem: no IDE extension, no cloud runs, no plugin marketplace, small user base. (A GitHub Action now ships.)

## Safety & permissions

| Feature | Aegis | Claude Code | Codex | Pi | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Allow/ask/deny rules | ✅ three layers, deny > ask > allow | ✅ settings.json | ⚠️ approval modes, some rules | ❌ none by design | ✅ per-tool + bash globs |
| Project trust | ✅ hash of exact bytes, re-asks on change | ⚠️ folder trust prompt | ⚠️ folder trust | ❌ | ⚠️ unverified |
| Hooks | ✅ Pre/PostToolUse, tighten-only, user file only | ✅ many events, can allow | ⚠️ unverified | ⚠️ extensions can intercept | ⚠️ plugins |
| OS sandbox | ❌ none | ✅ macOS/Linux, ❌ Windows | ✅ Seatbelt/Landlock; Windows ⚠️ | ❌ | ❌ |
| Secret redaction | ✅ files asked, output redacted | ❌ | ❌ | ❌ | ❌ |
| Shell policy | ✅ off unless `AEGIS_ALLOW_SHELL=1`; chained cmds never auto-allowed | ⚠️ on, rule-gated | ⚠️ on, sandboxed | ❌ on, ungated | ⚠️ on, rule-gated |
| Hardened git (hooks, filters off) | ✅ | ❌ | ❌ | ❌ | ❌ |

## Models & sign-in

| Feature | Aegis | Claude Code | Codex | Pi | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Claude plan sign-in | ⚠️ via real Claude Code engine only | ✅ | ❌ | ⚠️ was OAuth; blocked 2026 unverified | ⚠️ same |
| ChatGPT plan sign-in | ✅ device code + PKCE | ❌ | ✅ | ✅ | ✅ |
| API keys | ✅ OpenAI, OpenCode Zen, Google, local | ⚠️ Anthropic, Bedrock, Vertex | ⚠️ OpenAI + OSS via config | ✅ many providers | ✅ 75+ providers |
| Cheap/frontier routing | ✅ Jev scores each turn | ❌ | ❌ | ❌ | ❌ |
| Thinking control | ✅ /think, folded stream | ✅ | ✅ | ✅ | ✅ |

## Editing & tools

| Feature | Aegis | Claude Code | Codex | Pi | OpenCode |
| --- | --- | --- | --- | --- | --- |
| read / grep / glob | ✅ ignore-aware, worker thread, 20 s cap | ✅ | ⚠️ via shell | ✅ read, grep, find, ls | ✅ |
| edit / multi_edit / write | ✅ CRLF-safe, all-or-nothing | ✅ (MultiEdit folded into Edit) | ⚠️ apply_patch | ✅ edit, write | ✅ |
| Diff on every approval | ✅ trimmed hunks | ✅ | ✅ | ⚠️ shown after | ✅ |
| webfetch | ✅ host rules | ✅ | ⚠️ unverified | ❌ (extension) | ✅ |
| websearch | ✅ your Brave key; every query gated | ✅ | ✅ `--search` | ❌ | ⚠️ unverified |
| Images | ✅ @path, read, Studio paste | ✅ | ✅ | ✅ | ✅ |
| MCP | ✅ stdio + HTTP, per-server trust, no redirects | ✅ stdio + HTTP | ✅ | ❌ by design | ✅ |
| Subagents | ✅ `explore` + custom agents (agents/<name>.md), every call gated | ✅ custom agents, Task | ⚠️ unverified | ⚠️ extension | ✅ agents, @explore |
| Skills (SKILL.md) | ✅ hashed trust | ✅ | ✅ | ✅ | ✅ |

## Sessions & context

| Feature | Aegis | Claude Code | Codex | Pi | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Resume | ✅ -c, -r, /sessions, /resume n | ✅ | ✅ | ✅ | ✅ |
| Fork | ✅ /fork [n], copies checkpoints | ✅ --fork-session | ⚠️ unverified | ✅ session tree | ⚠️ unverified |
| Rewind / checkpoints | ✅ files + chat, no git needed | ✅ /rewind | ❌ | ⚠️ tree branching | ✅ /undo /redo (git snapshots) |
| Compaction | ✅ auto + /compact, summary in system prompt | ✅ | ✅ | ✅ | ✅ |
| Memory | ⚠️ /memory notes, manual | ✅ auto memory + CLAUDE.md | ⚠️ unverified | ❌ | ❌ |
| AGENTS.md | ✅ user, project, local | ⚠️ CLAUDE.md (AGENTS.md via import) | ✅ | ✅ | ✅ |
| Context meter | ✅ ctx % in footer | ✅ | ✅ | ✅ | ✅ |

## UX

| Feature | Aegis | Claude Code | Codex | Pi | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Full-screen TUI | ✅ pi-tui, themes, classic-console safe | ✅ | ✅ | ✅ | ✅ |
| Footer (branch, ctx, tokens) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bell / notify | ✅ /bell modes | ✅ | ⚠️ unverified | ⚠️ unverified | ⚠️ unverified |
| Message queue | ✅ esc returns text | ✅ | ✅ | ✅ | ✅ |
| Plan mode | ✅ gate-enforced read-only | ✅ | ⚠️ unverified | ❌ | ✅ plan agent |
| /diff | ✅ from checkpoints, redacted | ❌ | ✅ | ❌ | ⚠️ in UI |
| /review | ✅ P0–P3, hardened git | ✅ | ✅ | ❌ | ⚠️ via agents |
| Browser UI / IDE | ✅ Studio, localhost + key; ❌ IDE | ✅ web, desktop, IDE | ✅ app, IDE | ⚠️ unverified | ✅ web, desktop |

## Automation

| Feature | Aegis | Claude Code | Codex | Pi | OpenCode |
| --- | --- | --- | --- | --- | --- |
| Headless -p | ✅ asks become No, exit 2 on deny | ✅ | ✅ `codex exec` | ✅ | ✅ `opencode run` |
| JSON output | ✅ JSON lines | ✅ stream-json | ✅ | ✅ | ✅ |
| Per-run rules | ✅ --allow/--deny, floor still wins | ✅ --allowedTools | ⚠️ flags | ❌ | ⚠️ unverified |
| CI / GitHub Action | ✅ `action.yml`, prompt passed as data | ✅ | ✅ | ❌ | ✅ |
| Worktrees | ✅ --worktree, hardened checkout | ✅ | ⚠️ desktop app | ❌ | ⚠️ unverified |

## Gaps worth closing next

Closed the same night: websearch, HTTP MCP, the GitHub Action, custom agents (`agents/<name>.md`).

1. **OS sandbox on Windows** — AppContainer or a restricted job object for shell. The lock is not isolation; the README says so.
2. **Redaction in the Claude Code engine** — the biggest hole in the secrets story: Claude Code's own reads reach it before Aegis can cut anything.
3. **Auto memory** — Claude Code learns across sessions; Aegis needs manual `/memory`.
4. **Image input to the Claude Code engine** — `stream-json` input parts so pasted screenshots work there too.
5. **VS Code panel** — `-p --json` already fits; a thin extension would bring Aegis into the editor.

## Where Aegis is deliberately different

- **Shell off by default.** The others run shell first and ask second. Aegis needs `AEGIS_ALLOW_SHELL=1` and never auto-allows chained or wrapped commands.
- **Rules-first lock, tighten-only.** Jev, hooks and plugins can only make a decision stricter. Only a rule you saw can skip a question. Default answer is n.
- **No impersonation.** Aegis never poses as Claude Code or Gemini CLI for plan sign-in. Claude plans work only by driving the unmodified `claude` binary with its own hook.
- **A repo cannot arm itself.** Project allow rules, plugins, MCP servers and skills wait for `/trust`; hooks come only from your home folder; git hooks and filters are blanked.
- **Windows-first.** CRLF edits, 8.3 names, `icacls` on auth.json, System32-only lookups, Windows CI on every push.
- **Studio, not a cloud.** The browser face runs on your PC at 127.0.0.1 with a one-time key and strict CSP. Same lock, same sessions. Nothing phones home.
