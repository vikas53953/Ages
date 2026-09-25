#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`: reads the prompt, calls the PreToolUse hook from
// --settings exactly as Claude Code does (exec form, JSON on stdin), runs the tool only if allowed.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const settings = JSON.parse(readFileSync(flag("--settings"), "utf8"));
const hook = settings.hooks.PreToolUse[0].hooks[0];
const session = flag("--resume") ?? "claude-session-1";
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function askHook(tool_name, tool_input) {
  return new Promise((resolve) => {
    const child = spawn(hook.command, hook.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      if (code === 2) return resolve({ decision: "deny", reason: stderr.trim() });
      const parsed = JSON.parse(stdout).hookSpecificOutput;
      resolve({ decision: parsed.permissionDecision, reason: parsed.permissionDecisionReason });
    });
    child.stdin.end(JSON.stringify({ session_id: session, hook_event_name: "PreToolUse", cwd: process.cwd(), tool_name, tool_input }));
  });
}

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", async () => {
  out({ type: "system", subtype: "init", session_id: session, model: "claude-fake", resumed: Boolean(flag("--resume")) });
  if (prompt.includes("hang")) return setInterval(() => {}, 1000);
  const texts = [];
  if (prompt.includes("ping")) {
    const target = path.join(process.cwd(), "scripts", "ping.ps1");
    out({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Write the ping script." }, { type: "tool_use", id: "t1", name: "Write", input: { file_path: target, content: "Test-Connection 127.0.0.1" } }] } });
    const answer = await askHook("Write", { file_path: target, content: "Test-Connection 127.0.0.1" });
    if (answer.decision === "allow") {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "Test-Connection 127.0.0.1");
      texts.push("Wrote scripts/ping.ps1.");
    } else texts.push(`Blocked: ${answer.reason}`);
  }
  if (prompt.includes("delete")) {
    const answer = await askHook("Bash", { command: "Remove-Item -Recurse build" });
    if (answer.decision === "allow") writeFileSync(path.join(process.cwd(), "DELETED"), "yes");
    texts.push(answer.decision === "allow" ? "Deleted build." : `Blocked: ${answer.reason}`);
  }
  if (prompt.includes("secrets")) {
    const answer = await askHook("Read", { file_path: path.join(path.dirname(process.cwd()), "secret-outside.txt") });
    texts.push(answer.decision === "allow" ? "read it" : `Blocked: ${answer.reason}`);
  }
  if (prompt.includes("todo")) {
    const answer = await askHook("TodoWrite", { todos: [] });
    texts.push(`todo ${answer.decision}`);
  }
  if (flag("--permission-mode")) texts.push(`mode=${flag("--permission-mode")}`);
  const text = texts.join(" ") || `Echo: ${prompt.trim()} (resumed=${Boolean(flag("--resume"))})`;
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: session,
    usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 42 },
  });
});
