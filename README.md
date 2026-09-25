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
| `/task` | delivery card (confirm / accept are owner-only) |
| `/exit` | quit |

Missing Jev keys block writes. `--mock-jev` is tests only. Shell stays off unless `AEGIS_ALLOW_SHELL=1`. Jev and shell-off do not sandbox generated Node; that is not OS isolation.

