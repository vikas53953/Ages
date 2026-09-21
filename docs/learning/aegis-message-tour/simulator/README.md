# Aegis Message Lab

Interactive classroom simulator. Preserves the original tour at `../index.html`.

From the repository root:

```powershell
node docs/learning/aegis-message-tour/simulator/build.mjs
node docs/learning/aegis-message-tour/simulator/test.mjs
python -m http.server 8769 --bind 127.0.0.1 --directory docs/learning/aegis-message-tour
```

Open http://127.0.0.1:8769/simulator/ (reuse the existing server if already running).

## Teaching sequence

1. Watch startup: process launch, TypeScript entrypoint, TUI creation, session and event handler.
2. Normal conversation: trace Enter through runtime, context, Jev, routing, model and reply.
3. Read → edit → read: see proposed JSON, gate, policy, execution, tool result and the next model step.
4. Approve an edit, then replay and deny it: inspect the different workspace outcomes.
5. Compare evaluator-unavailable, shell-disabled and unsupported web/computer paths.
6. Type a message, change routing/evaluator controls, then Send. Free text uses a simple scenario heuristic, not AI understanding.

Play/Pause animates the packet. Next/Back and the timeline inspect recorded states. Replay resets the virtual workspace. Cancel stops the illustrated turn at the displayed event; prior virtual changes remain. The code panel follows each call and can show the complete selected file.

## Fidelity boundary

The build script transpiles **actual** `parseLine`, `mockTurn`, `mockTool`, `pickModel`, and `decideToolAction` implementations to browser modules. It also captures 41 source/config/entrypoint files with SHA-256 hashes and a timestamp. Run it again to refresh after source changes.

The runtime trace, AI responses, provider network request, SDK tool loop, storage and tool bodies are **illustrations**. The browser uses an in-memory sample filesystem, not Node tools. The tool-error receipt is explicitly illustrative: actual SDK error handling can differ, and the current gate records successful returns via `.then`. This demo does not prove the harness's safety or cancellation behavior.

Low-confidence and unavailable evaluator settings are controlled fixtures. Live Jev requires an external provider and is not called. Model routing can still choose frontier after a fail-closed turn score; the tool policy denies fail-closed tool scores. No budget-enforcement guarantee is implied.

Web and computer use are not registered tools in this snapshot. Those examples terminate at the capability boundary rather than inventing an execution path. Local slash-command outputs other than help are illustrative; this lab doesn't enumerate real sessions or mutate their data. It does not reproduce every internal dependency function or every operating-system failure mode.

## Verification

`test.mjs` checks all 23 presets plus approval/denial, virtual read-edit-read consistency, failed evaluator behavior, path/edit/missing-file/shell failures, slash-command model bypass, cancellation and unsupported capabilities. Browser interaction checks cover visible approval and virtual mutation; these are simulator checks, not a regression suite for Aegis itself.
