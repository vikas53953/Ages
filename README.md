# Aegis

The agent you own. Jev locks spend and danger.

That is the difference: other CLIs just run. Aegis scores the turn (spend) and each tool (danger) before anything happens.

```powershell
cd C:\Users\vikasmit\Projects\gate
aegis
```

TTY opens the TUI. `aegis --repl` is the plain prompt. `aegis --local --mock-jev` is the no-network demo.

| Type | What happens |
| --- | --- |
| `/models` | every OpenCode model |
| `/model auto` | Jev picks cheap vs frontier |
| `/model glm-5.3` | pin a model |
| `hello` | the routed or pinned model answers |
| `/help` | slash commands |
| `/task` | delivery card (confirm / accept are owner-only) — delivery plugin |
| `/jev` | show or set the Jev mode (off / second / every) — jev plugin |
| `/exit` | quit |

Rules in `.aegis/settings.json` decide first (deny, then ask, then allow). Jev only scores what no rule matches, and can only make a decision stricter. `/jev off|second|every` sets the mode. With no Jev key, reads and allowed calls still run and everything else asks you (default n). `--mock-jev` is tests only. Shell stays off unless `AEGIS_ALLOW_SHELL=1`. Jev and shell-off do not sandbox generated Node; that is not OS isolation.

Layers: a small core (loop, tools, session, compaction, router, rules gate, TUI) and plugins (`jev`, `delivery`, `receipts`) listed under `"plugins"` in `.aegis/settings.json`. See `PROJECT-MAP.md`.
