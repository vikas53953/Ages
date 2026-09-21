# Codex review packet — Aegis

**Please be fair and honest.** Do not flatter. Do not rubber-stamp. If this is a thin clone with extra steps, say that. If the TUI should be thrown away and rebuilt on a real toolkit, say that. If Jev-in-the-loop is the only thing worth keeping, say that too. We want the kind of review that saves the next month, not a polite summary.

Repo: `C:\Users\vikasmit\Projects\gate`  
Product name: **Aegis** (command `aegis`)  
Owner: Vikas. Windows / PowerShell. This Cursor chat is helm; he does not want extra agent CLIs spawned from here.

---

## What we are doing

Build **our own** coding-agent CLI that we own. Not a wrapper around someone else's product.

Shape of the product (what “done” feels like to the owner):

1. Type one word in PowerShell, like `pi` or `claude`: **`aegis`**.
2. A real terminal UI opens: launch card, chat transcript, composer at the bottom, caret **inside** the composer.
3. User turns and assistant turns look different. The view moves when you press Enter.
4. Slash commands work (`/models`, `/model <id>`, `/help`, sessions, memory, compact).
5. Tools run in the working folder: read, write, edit, grep, shell (PowerShell).
6. **Jev** (TypeSafe System One) is the lock: it scores the turn (cheap vs frontier, fail-closed) and each tool (auto vs y/N, default **n**). The model writes. Code enforces.

**Why we exist (claimed USP):** other agent CLIs just run. Aegis scores spend and danger *before* a turn or a tool happens. If that USP is not visible in the architecture, call it out.

**Non-goals for this slice:** markdown streaming, session tree UI, extension SDK, themes, copy of another product’s chrome.

---

## What we have done so far

Walking skeleton in TypeScript (Node 22+, `tsx`, Vitest). **No git commits yet** — everything is uncommitted on `main`. Last test run: **52 passing**, `tsc --noEmit` clean.

### Loop (this is the product)

- `src/loop.ts` — one turn: Jev evaluate turn → pick/pin model → `generateText` + tools → receipt.
- `src/jev/` — live Jev via `@ai-sdk/typesafe-ai`, plus mock Jev when no TypeSafe key.
- `src/gated.ts` + `src/policy.ts` — tool class + data_loss → auto or confirm (default n).
- `src/router.ts` — cheap vs frontier from Jev (architecture / hard / low confidence → frontier).
- `src/tools/` — cwd-only sandbox: read, write, unique-string edit, grep, PowerShell shell.
- `src/receipt.ts` — stamp written under `.harness/receipts`.

### Harness surface (Pi-shaped, not a Pi clone)

- `src/cli.ts` — TTY → TUI; `--repl` for pipes; one-shot prompt.
- `src/runtime.ts` — slash commands + `runPrompt`, shared by TUI and REPL.
- `src/session.ts` / `compact.ts` / `memory.ts` / `skills.ts` / `context.ts` — sessions, compact, memory, `skills/*.md`, `AGENTS.md`.
- `src/commands.ts` — `/help /new /sessions /resume /memory /skills /compact /clear /models /model /status /exit`.
- `src/catalog.ts` + `src/model-pin.ts` — live OpenCode Zen model list + pin in `.harness/model`. Selected model is used for the turn (`routeReason: "selected"`). Default chat model is `glm-5.3`, not flash-only.
- `src/providers.ts` — OpenCode Zen preferred (`OPENCODE_API_KEY`); chat / responses / messages / gemini routed by model id. Local planner if no key (`--local`).
- Launch: `aegis` on user PATH via `npm link` (`%APPDATA%\npm\aegis.ps1`). Also `.\aegis.cmd` in the repo.

### TUI (this is the sore spot)

Homegrown ANSI, **not** Pi’s component TUI (`@earendil-works/pi-tui`) and **not** Claude Code’s renderer.

Current layout (after several rewrites):

- Transcript on top (welcome + messages, latest pinned above the dock).
- 3-line teal composer box + footer dock (Pi *architecture*: transcript grow, editor+footer shrink).
- Hardware cursor via a zero-width marker (`CURSOR_MARKER`), stripped after layout, then CUP — because earlier paints wrote extra `\r\n` and the caret sat on a different row than the box.
- User turn: `◆` in teal. Assistant: indented plain text. Composer: `›` inside a box.

What the owner has said, more than once, and we still have not earned:

- It does not feel like launching Claude Code or Pi.
- Cursor and input box have been misaligned.
- Screen does not “move up” when sending.
- Chrome looked copied (orange two-column card, `>` used for both composer and user lines).
- Name `gate` / `harness` felt cheap. Current name is **Aegis** (shield = Jev lock). If that name is weak, say so.

**Honest status:** unit tests cover layout/cursor math. The owner’s eyes have not yet signed off on the live TUI. Treat TUI as unverified UX.

### What is *not* done

- No streaming tokens.
- No markdown render in the transcript.
- No TUI toolkit (we reimplemented a tiny dock + paint).
- No session tree, no image paste, no bash-mode `!`, no extension host.
- GPT/Claude/Gemini on Zen use other endpoints; listing works; live quality on those APIs is lightly proven. Chat-completions models (GLM, Kimi, DeepSeek, MiniMax) are the ones that actually ran.
- Jev live vs mock: auto-mock if no TypeSafe key. Owner does have TypeSafe keys in gitignored `.env.local`.
- Branding files still say “Harness” in `AGENTS.md` / `PROJECT-MAP.md` / `implementation-notes.md` — drift.
- Danger confirm in TUI exists (`[y/N]`) but the overall UX is not a product yet.

---

## Architecture in one page

```
PowerShell  →  aegis (bin)  →  src/cli.ts
                                ├─ TTY? src/tui.ts
                                └─ else REPL / one-shot
                                       ↓
                                src/runtime.ts  (slash + runPrompt)
                                       ↓
                                src/loop.ts
                                  Jev.evaluateTurn
                                  pin or pickModel
                                  generateText + tools
                                    each tool → src/gated.ts → Jev.evaluateTool
                                  write receipt
```

TUI paint (intended):

```
VStack
  transcript (welcome + ◆ user / plain assistant)   grow
  dock
    composer (3-line box, CURSOR_MARKER at caret)
    footer (model · jev on · provider)
hardware cursor = extract marker → CUP
```

Compare to Pi (read-only study, do not copy source): Pi uses `@earendil-works/pi-tui` with `createChatViewport` (ScrollView transcript + VStack dock: pending, status, editor minSize 3, footer) and `CURSOR_MARKER` for IME/caret. We copied the *layout idea*, not the toolkit.

---

## Constraints you must respect in feedback

- Windows-native. PowerShell. No tmux, no assuming a Unix TTY.
- Do not bypass Jev. Default confirm is **n**.
- Stay in this folder. Tools must not escape cwd.
- Owner wants to *understand* the code (network background). Prefer structural advice over “add a library and forget”.
- He will reject “looks like we copied Claude.” Flavor must be ours; the *experience bar* is still those TUIs.

---

## Ask — fair, honest, specific

Please review the **repo as it exists**, not the README. Then answer:

1. **Keep vs rewrite the TUI.** Is a homegrown CUP painter a dead end on Windows, or is it enough if we finish the dock correctly? Would you put `pi-tui` / Ink / something else under us, or keep owning the renderer?

2. **Is Jev actually in the hot path for a normal chat?** When a model is pinned, we skip cheap/frontier routing (`reason: "selected"`). Tool gating still runs. Is that the right product, or did we neuter the USP?

3. **Clone risk.** Where does this still read as a sketch of Pi/Claude rather than Aegis? Name files and behaviors.

4. **Next 1–2 weeks.** Ordered list. What we should *stop* doing. What is the thinnest path to an owner-signed TUI + a trustworthy Jev lock.

5. **Safety.** cwd sandbox, shell, confirm-default-n — holes?

6. **Name.** Aegis vs something better. One sentence.

7. **Defects.** P0/P1/P2 from the code, with path:line. Skip style nits.

Write findings first. Then a short overall verdict: *ship this direction*, *pivot the TUI*, or *narrow to Jev-lock + REPL until the TUI is real*.

---

## How to run

```powershell
cd C:\Users\vikasmit\Projects\gate
npx vitest run
npx tsc --noEmit
aegis --help
# interactive (needs a real TTY):
aegis
```

Env (gitignored `.env.local`, do not print secrets): `OPENCODE_API_KEY`, TypeSafe/Jev keys, `GATE_MODEL` / `GATE_FRONTIER_MODEL`.

Start in `src/cli.ts`, `src/loop.ts`, `src/tui.ts`, `src/tui-layout.ts`, `src/gated.ts`, `src/jev/`.
