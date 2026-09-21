# Independent review of Cursor's 82-test delivery

Reviewed 2026-09-20 against the current working tree, Cursor's completion message, and the relevant delivery requirements. No commit baseline exists; this is an implementation audit, not an attributed diff. The original review packet is outdated about the renderer: Aegis now uses pi-tui components.

## Findings

### P1 — A caller can manufacture a verified result without running a check

`src/delivery.ts:267–282` rejects only the literal kind `summary`, then trusts caller-supplied status, output and exitCode. `renderCard`, line 363, treats `status === "passed"` as verified without reconciling exitCode. `scripts/record-this-slice.ts:56` builds a success string and lines 58 onward insert handwritten descriptions as test output; that script executes no verification commands.

Reproduced by calling recordCheck with kind=test, status=passed, command="never executed", output="Model says done", exitCode=1. The card displayed `c1: passed  never executed  exit 1` under Verified.

This is the exact original product risk: an agent-written assertion becomes a professional-looking green card. It does not mean the 82 tests failed; I separately ran them successfully. Fix: derive command status from a runner's captured result, retain raw output, and treat imported descriptions as reported/unverified. Merely checking exitCode would not establish that execution happened.

### P1 — Revised requirements retain evidence for the previous requirement

`src/delivery.ts:222–246` compares criterion IDs, not their text, and retains existing evidence. Checks carry a criterionId but no agreement revision/hash. `loadTask` only invalidates by source hash (line 156), while `renderCard` selects by criterionId (line 353 onward).

Reproduced: record a pass for c1, change c1's text to a completely different requirement through reviseAgreement, keeping the ID. The prior check remains passed and non-stale; revision.weakened is false. The agreement becomes proposed, which is good, but confirming it again would still reuse the old result. Fix: bind evidence to the complete agreement revision and invalidate affected checks whenever meaning changes. Preserve the old evidence as history.

### P2 — Cancellation cannot promptly settle a hanging Jev evaluation

`src/gated.ts:105–111` and `src/loop.ts:189–195` directly await evaluation and only inspect cancellation after it returns. The Jev interface and live evaluator do not receive an AbortSignal. TUI submit stays busy until the awaited turn finishes (`src/tui-app.ts:234–266`).

Reproduced: a deferred evaluateTool remains unresolved after abort; the gate settles only when the probe manually releases the evaluator. Existing tests abort inside an evaluator that immediately returns, so they prove no subsequent execution, not cancellation of a hung request. The hanging-confirm race is separately implemented and tested. Fix: propagate cancellation to the evaluator request and bound/race the wait, retaining the checks that prevent late writes.

### P2 — Agreement confirmation gates a label, not implementation

`assertReadyToImplement` is called only by `markImplemented` (`src/delivery.ts:319`). The production tool path in `src/loop.ts:46–59` and `src/gated.ts` does not consult the agreement.

Reproduced: with an existing proposed agreement, the normal createTools().write executor successfully writes a fixture file using a permitted mock Jev decision. No /task confirm is needed. Fix: for a turn participating in controlled delivery, enforce the confirmed agreement before mutation. Keep ordinary untracked chat behavior explicit; do not imply all chat must be blocked.

### P2 — Freshness identifies the harness source, not the delivered application

`captureIdentity()` (`src/delivery.ts:82–97`) hashes packageRoot()/src TypeScript files plus APP_VERSION. It takes no task cwd. Dependencies, configuration, non-TypeScript assets and tests are excluded, and loadTask only compares srcHash.

Reproduced: changing a task workspace's src/application.ts leaves captureIdentity().srcHash unchanged. This works narrowly for edits to Aegis's own src, but cannot establish that another application opened for the owner is the one verified. Even for Aegis, package-lock/config changes are missed. Fix: record separate harness identity and task artifact/workspace identity, with the relevant inputs and environment bound to evidence.

## Verified improvements

- Independently ran npm test: 21 files, 82 tests passed.
- Independently ran npm run typecheck: exit 0.
- A separate real Windows junction probe created the junction successfully, then confirmed write denial before creation of the outside nested directory. The two fixture roots were both inside this repository; no external files were touched.
- Gate cancellation checks prevent execution after evaluation returns aborted; hanging-confirm cancellation and later-tool denial are covered.
- The TUI uses pi-tui widgets, with MemoryTerminal tests for editing, paste, scrolling, resize and approval behavior.
- Confirm text includes write payloads and edit diffs, with an explicit 80,000-character clipping limit. That limit is not complete visibility of an arbitrarily large action.
- Jev health requires an actual `source === "jev"` result for live; fail-closed and missing-key paths report down/blocked.
- Agreement proposed, implementation flag, check state and owner acceptance are visibly separate. This review did not confirm or accept the owner's task.

## Remaining product boundaries

- No live owner Windows Terminal UX sign-off was performed. MemoryTerminal passing is not that sign-off.
- No paid model/Jev calls were made for this review.
- A fail-closed turn score still reaches generation with the frontier route. I reproduced that using an injected generator with no network. Tool denial is distinct from a spend limit, as the new card disclaimer correctly states.
- Receipts and evidence are ordinary editable files, not a tamper-resistant audit boundary. The findings above do not depend on manually tampering with those files; they use the supported functions.
- Test output and TypeScript completion were captured during review. The adversarial delivery probes ran in `review-probe-JkzQg6`, never in the owner's `.harness/task` record. No implementation files were changed by this review.

## Verdict

Keep this direction and the toolkit migration. The harness has improved; the delivery system is a recordkeeping prototype, not yet a verification-backed handoff. Fix evidence provenance and agreement/version binding first, then connect agreement enforcement and finish evaluation cancellation. After those targeted regressions pass, perform one real Windows Terminal walkthrough and one real task handoff with the owner.
