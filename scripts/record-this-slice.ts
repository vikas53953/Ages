import path from "node:path";
import { packageRoot } from "../src/env.ts";
import {
  noteChanged,
  recordMissing,
  renderTaskCard,
  runCheck,
  writeAgreement,
} from "../src/delivery.ts";

const cwd = process.cwd();
const vitest = path.join(packageRoot(), "node_modules", "vitest", "vitest.mjs");
const node = process.execPath;

await writeAgreement(cwd, {
  id: "controlled-delivery",
  objective:
    "Implement controlled delivery with inspectable evidence. Keep Aegis’s owned minimal engine. Preserve current work and continue the TUI migration.",
  scope: [
    "Close remaining foundation gaps: cancel, cwd confinement, inspectable approval, Jev status.",
    "Windows TUI migration demonstration, automated vs live.",
    "Minimal task agreement, evidence record, delivery card.",
  ],
  acceptance: [
    { id: "cancel", text: "Cancellation must prevent subsequent tool mutations and settle pending approvals." },
    { id: "cwd", text: "Filesystem confinement must prevent escapes before mutation; a post-write check is insufficient." },
    { id: "approve", text: "Approval must expose the complete action/diff before consent." },
    { id: "jev", text: "Jev status must reflect actual evaluation outcomes, not merely key presence." },
    { id: "tests", text: "Add targeted regression tests." },
    { id: "tui-auto", text: "Demonstrate input, paste, scroll, resize, approvals and cancellation in automated TUI checks." },
    { id: "tui-live", text: "Real interactive Windows Terminal verification by the owner." },
    { id: "agreement", text: "Objective, scope, acceptance, exclusions, optional references. Owner confirms before implementation. Revisions visible. No silent weaken." },
    { id: "evidence", text: "Per criterion passed/failed/blocked/not_run with check output, env, identity. Summaries cannot set passed. Stale after change. Preserve failures." },
    { id: "card", text: "Requested / Changed / Verified / Not verified. Implemented, checks passed, owner accepted stay separate. Only explicit owner action records acceptance." },
  ],
  exclusions: [
    "Agent fleet",
    "Model-catalog expansion",
    "General workflow framework",
    "Git commit",
    "Inventing Vikas’s acceptance",
    "Claiming screenshots prove functionality, tests prove product acceptance, or Jev scores provide OS isolation or spending limits",
  ],
  references: ["docs/task-agreement.md", "docs/status.md"],
  status: "proposed",
});

await noteChanged(cwd, [
  "src/delivery.ts",
  "src/gated.ts",
  "src/loop.ts",
  "src/abort.ts",
  "src/jev/evaluate.ts",
  "tests/delivery.test.ts",
  "tests/jev-lock.test.ts",
]);

await runCheck(cwd, {
  criterionId: "cancel",
  argv: [node, vitest, "run", "tests/jev-lock.test.ts"],
  workdir: cwd,
});
await runCheck(cwd, {
  criterionId: "cwd",
  argv: [node, vitest, "run", "tests/cwd.test.ts"],
  workdir: cwd,
});
await runCheck(cwd, {
  criterionId: "approve",
  argv: [node, vitest, "run", "tests/jev-lock.test.ts"],
  workdir: cwd,
});
await runCheck(cwd, {
  criterionId: "jev",
  argv: [node, vitest, "run", "tests/tui-app.test.ts"],
  workdir: cwd,
});
await runCheck(cwd, {
  criterionId: "tests",
  argv: [node, vitest, "run"],
  workdir: cwd,
});
await runCheck(cwd, {
  criterionId: "tui-auto",
  argv: [node, vitest, "run", "tests/tui-app.test.ts"],
  workdir: cwd,
});
await recordMissing(cwd, {
  criterionId: "tui-live",
  command: "aegis (Windows Terminal)",
  note: "No owner interactive session in this Cursor run. Automated MemoryTerminal is not live UX.",
});
await runCheck(cwd, {
  criterionId: "agreement",
  argv: [node, vitest, "run", "tests/delivery.test.ts"],
  workdir: cwd,
});
await runCheck(cwd, {
  criterionId: "evidence",
  argv: [node, vitest, "run", "tests/delivery.test.ts"],
  workdir: cwd,
});
await runCheck(cwd, {
  criterionId: "card",
  argv: [node, vitest, "run", "tests/delivery.test.ts"],
  workdir: cwd,
});

const card = await renderTaskCard(cwd);
console.log(card);
