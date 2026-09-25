# Aegis

The coding agent you own. Rules decide first; plugins add the rest.

Other agent CLIs just run. Every Aegis tool call passes a lock first: your rules in `.aegis/settings.json`, then (optionally) Jev's spend/danger score, then you — default **n**.

![Aegis welcome screen](docs/screens/1-welcome.png)

| `/` commands | A turn: each tool shows what decided it |
| --- | --- |
| ![slash commands](docs/screens/2-slash-commands.png) | ![a turn](docs/screens/3-turn.png) |

Screenshots are the real `aegis` in a pseudo-terminal (`--local`, no model key).

### Aegis Studio — the same core in your browser

`aegis ui` opens a chat page served from your own PC (127.0.0.1 only, with a one-time key in the link). Same rules, sessions and plugins as the terminal; approvals are cards with **Allow once**, **Always allow "rule"** and **Deny**.

| Approval card | Finished turn: why each tool ran, tokens |
| --- | --- |
| ![approval](docs/screens/studio-approval.png) | ![turn](docs/screens/studio-turn.png) |

Screenshots are the real Studio in Chromium with a scripted model.

## 1. Install

Windows PowerShell (needs Node.js 22.19+):

```powershell
irm https://raw.githubusercontent.com/vikas53953/Ages/main/install.ps1 | iex
```

Linux, macOS, or a cloud container:

```bash
curl -fsSL https://raw.githubusercontent.com/vikas53953/Ages/main/install.sh | sh
```

Or with npm directly (any branch, tag or commit in place of `main`):

```bash
npm install -g https://github.com/vikas53953/Ages/archive/main.tar.gz
```

Until the work branch is merged, install it instead:

```powershell
npm install -g https://github.com/vikas53953/Ages/archive/claude/quirky-ramanujan-6bpqc3.tar.gz
```

(Not `github:vikas53953/Ages` — npm 10 links git installs to a temporary clone it deletes afterwards.)

Check it:

```powershell
aegis --version
```

## 2. Start

In the folder you want it to work in:

```powershell
cd C:\path\to\project
aegis
```

A terminal opens the full-screen TUI with the welcome screen. `aegis --repl` is the plain prompt (pipes, scripts). `aegis "a question"` answers once and exits.

## 3. Connect a model

Inside Aegis, once — saved to `~\.aegis\.env` for every folder:

```text
/login opencode <your-key>
/login jev <your-typesafe-key>      (optional: turns on Jev scoring)
```

## Everyday commands

| Type | What happens |
| --- | --- |
| `/` | command list (autocomplete); `@` completes file names |
| `/help` | every command, core and plugins |
| `/model` | model picker (type to filter, Enter picks); `/model glm-5.3` pins directly, `/model auto` lets Jev pick |
| `/think low\|medium\|high\|off` · `/think fold\|show\|hide` | how hard the model thinks · how its reasoning appears; `ctrl+t` folds/opens it |
| `/theme aegis\|light\|contrast` | colours, saved for every folder |
| `aegis ui` | Aegis Studio in the browser (`--port N`, `--no-open`) |
| `/compact` | fold old turns into a summary (also automatic when history is big) |
| `/jev off\|second\|every` | Jev mode — jev plugin |
| `/task` | delivery card (confirm / accept are owner-only) — delivery plugin |
| `/status` · `/login` | what is loaded · which keys are set |
| `!dir` · `!!dir` | run PowerShell yourself; output joins the chat · or doesn't |
| `esc` | stop the running turn (at a y/N prompt: no) |
| `a` at a prompt | always allow: saves a narrow rule (`edit scripts/*`, or that exact command) so it stops asking |
| `ctrl+c` | stop a turn / clear the prompt; twice on an empty prompt exits |
| `aegis -c` | continue the last session (every launch is otherwise new, like Pi) |

## The lock

Rules decide first (deny, then ask, then allow). Paths are matched relative to the folder, so `C:\proj\.git\x` is `.git/x`. Jev only scores what no rule matches, and can only make a decision stricter. With no Jev key, reads and allowed calls still run and everything else asks you. "Always allow" is never offered when an ask rule matched, for chained or wrapped commands (`pwsh -c`, `cmd /c`, `iex`), or for `.git`, `.harness`, `.aegis`. Shell (PowerShell) stays off unless `AEGIS_ALLOW_SHELL=1`. None of this is OS isolation: generated code runs with your rights.

## Layers

A small core (loop, tools, session, compaction, router, rules gate, TUI) and plugins (`jev`, `delivery`, `receipts`) listed under `"plugins"` in `.aegis/settings.json`. See `PROJECT-MAP.md`.

## Develop

```powershell
git clone https://github.com/vikas53953/Ages; cd Ages; npm install
npm start              # run from source (tsx)
npm test               # Vitest
npm run check:windows  # end-to-end checks (real PowerShell on Windows)
npm run build          # compile to dist/ — commit dist/ with your change (installs run it; CI checks it is fresh)
```

Every push runs typecheck, Vitest, the end-to-end check and an install test on a Windows runner (`.github/workflows/windows-check.yml`).
