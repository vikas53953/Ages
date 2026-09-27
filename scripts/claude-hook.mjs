#!/usr/bin/env node
// Claude Code PreToolUse hook → Aegis's lock. Claude Code runs this before every tool call when Aegis
// starts it as an engine. It forwards the call to the Aegis process that started Claude Code, which runs
// its rules (and Jev, and you) and answers allow or deny. Anything that goes wrong blocks the call
// (exit 2): the lock fails closed.
const url = process.env.AEGIS_HOOK_URL;
const token = process.env.AEGIS_HOOK_TOKEN;

function block(reason) {
  process.stderr.write(`Aegis blocked this tool call: ${reason}\n`);
  process.exit(2);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", async () => {
  if (!url || !token) block("no Aegis session to ask (AEGIS_HOOK_URL is not set)");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aegis-token": token },
      body: input || "{}",
    });
    if (!response.ok) block(`Aegis answered ${response.status}`);
    const answer = await response.json();
    const decision = answer.decision === "allow" ? "allow" : "deny";
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision,
          permissionDecisionReason: String(answer.reason ?? (decision === "allow" ? "allowed by Aegis" : "denied by Aegis")),
        },
      }),
    );
    process.exit(0);
  } catch (error) {
    block(error instanceof Error ? error.message : String(error));
  }
});
