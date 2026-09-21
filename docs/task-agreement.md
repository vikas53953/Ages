# Task agreement — controlled delivery

Proposed to Vikas. Copied from his 20 Sep 2026 request. Not owner-accepted.

## Objective

Implement the next Aegis slice: controlled delivery with inspectable evidence. Keep Aegis’s owned minimal engine. Preserve current work and continue the TUI migration.

## Scope

1. Verify and close remaining foundation gaps (cancel, cwd confinement, inspectable approval, Jev status) with targeted regression tests.
2. Finish the Windows TUI migration and demonstrate input, paste, scroll, resize, approvals and cancellation. Distinguish automated checks from real interactive verification.
3. Minimal task agreement (objective, scope, acceptance, exclusions, optional references). Owner confirms before implementation. Revisions visible. Never silently weaken criteria.
4. Evidence record per criterion (passed / failed / blocked / not run) with check output, environment, source identity. Summaries cannot set passed. Stale after relevant changes. Preserve failures and missing checks.
5. Delivery card: Requested / Changed / Verified / Not verified. Implemented, checks passed, and owner accepted stay separate. Only explicit owner action records acceptance.

## Acceptance

Copied from the request, not invented:

- Cancellation must prevent subsequent tool mutations and settle pending approvals.
- Filesystem confinement must prevent escapes before mutation; a post-write check is insufficient.
- Approval must expose the complete action/diff before consent.
- Jev status must reflect actual evaluation outcomes, not merely key presence.
- Targeted regression tests for those gaps.
- TUI: input, paste, scroll, resize, approvals, cancellation demonstrated.
- Automated checks distinguished from real interactive verification.
- Agreement fields as listed; owner confirm before implementation; revisions visible; no silent weaken.
- Evidence per criterion with real check output, env, identity; no summary-as-pass; stale after change; preserve failures/missing.
- Delivery card sections as listed; screenshots do not prove functionality.
- Implemented / checks passed / owner accepted are separate.
- Only explicit owner action records acceptance.
- First version local and small: one task, one agent, ordinary files.

## Exclusions

- Agent fleet
- Model-catalog expansion
- General workflow framework
- Git commit
- Claiming screenshots prove functionality, tests prove product acceptance, or Jev scores provide OS isolation or spending limits
- Inventing Vikas’s acceptance

## References

- `src/delivery.ts`
- `.harness/task/` (local records)
- `/task` `/task confirm` `/task accept`

Confirm in Aegis with `/task confirm`. Accept delivery with `/task accept`. Neither is implied by tests passing.
