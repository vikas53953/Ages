# Aegis

The coding agent you own. Rules decide first; plugins add the rest.

Other agent CLIs just run. Every Aegis tool call passes a lock first: your rules in `.aegis/settings.json`, then (optionally) Jev's spend/danger score, then you — default **n**.

## 1. Install

Windows PowerShell (needs Node.js 22.19+ and git):

```powershell
irm https://raw.githubusercontent.com/vikas53953/Ages/main/install.ps1 | iex
```

Linux, macOS, or a cloud container:

```bash
curl -fsSL https://raw.githubusercontent.com/vikas53953/Ages/main/install.sh | sh
```

Or straight from npm's git support:

```bash
npm install -g github:vikas53953/Ages
```

Until the work branch is merged, install it instead with `$env:AEGIS_REF = "claude/quirky-ramanujan-6bpqc3"` (PowerShell) or `AEGIS_REF=claude/quirky-ramanujan-6bpqc3` (sh) before the installer, or `npm install -g "github:vikas53953/Ages#claude/quirky-ramanujan-6bpqc3"`.

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
| `/model auto` · `/model glm-5.3` | Jev picks cheap vs frontier · pin a model |
| `/compact` | fold old turns into a summary (also automatic when history is big) |
| `/jev off\|second\|every` | Jev mode — jev plugin |
| `/task` | delivery card (confirm / accept are owner-only) — delivery plugin |
| `/status` · `/login` | what is loaded · which keys are set |
| `ctrl+c` | stop the running turn; on an empty prompt, exit |

## The lock

Rules decide first (deny, then ask, then allow). Jev only scores what no rule matches, and can only make a decision stricter. With no Jev key, reads and allowed calls still run and everything else asks you. Shell (PowerShell) stays off unless `AEGIS_ALLOW_SHELL=1`. None of this is OS isolation: generated code runs with your rights.

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
