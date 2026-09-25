/**
 * `aegis doctor` / `/doctor`: is this PC ready? One line per check (ok / warn / fail) with the fix.
 * Nothing is started or changed: it reads files, asks programs for their version, and pings the chat endpoint.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { authFile, loadCredential } from "./auth/store.ts";
import { CODEX_CREDENTIAL, codexApiBase } from "./auth/codex.ts";
import { APP_VERSION } from "./brand.ts";
import { findClaude } from "./engines/claude-code.ts";
import { ignoredProjectEnv, packageRoot, userAegisDir } from "./env.ts";
import { mcpServers } from "./mcp.ts";
import { resolveProvider } from "./providers.ts";
import { loadSettingsSafe, settingsPath } from "./rules.ts";
import { powershellExe } from "./tools/fs.ts";
import { shellAllowed } from "./tools/shell.ts";

export type Check = { status: "ok" | "warn" | "fail"; item: string; detail: string; fix?: string };

const MIN_NODE = [22, 19];

function version(command: string, args: string[] = ["--version"]) {
  const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const run = spawnSync(shim ? `"${command}"` : command, args, { encoding: "utf8", timeout: 8000, windowsHide: true, shell: shim });
  return run.status === 0 ? (run.stdout || run.stderr).trim().split(/\r?\n/)[0] : undefined;
}

/** Who else can read a secrets file: POSIX mode bits, or the Windows ACL (icacls). */
function privateFile(file: string): { ok: boolean; detail: string } {
  if (process.platform !== "win32") {
    const mode = statSync(file).mode & 0o777;
    return { ok: (mode & 0o077) === 0, detail: `mode ${mode.toString(8)}` };
  }
  // Security IDs, not names: group names are translated on non-English Windows ("Jeder", "Utilisateurs").
  const acl = spawnSync(
    powershellExe(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Acl -LiteralPath $env:AEGIS_ACL_FILE).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15_000, env: { ...process.env, AEGIS_ACL_FILE: file } },
  );
  if (acl.status !== 0) return { ok: false, detail: "could not check who can read it" };
  const everyone: Record<string, string> = { "S-1-1-0": "Everyone", "S-1-5-32-545": "Users", "S-1-5-11": "Authenticated Users", "S-1-5-7": "Anonymous", "S-1-5-4": "Interactive" };
  const wide = acl.stdout.split(/\r?\n/).map((line) => line.trim()).find((sid) => everyone[sid]);
  return { ok: !wide, detail: wide ? `readable by ${everyone[wide]} (${wide})` : "only your account (and SYSTEM/Administrators)" };
}

async function reachable(url: string) {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    return { ok: true, detail: `HTTP ${response.status}` };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return { ok: false, detail: cause ?? (error instanceof Error ? error.message : String(error)) };
  }
}

export async function runDoctor(cwd: string, options: { network?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);

  // Node and the install itself.
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = major > MIN_NODE[0]! || (major === MIN_NODE[0] && minor >= MIN_NODE[1]!);
  add({
    status: nodeOk ? "ok" : "fail",
    item: "Node.js",
    detail: `v${process.versions.node}`,
    fix: nodeOk ? undefined : "Aegis needs Node 22.19 or newer: winget upgrade OpenJS.NodeJS.LTS",
  });
  const root = packageRoot();
  add({ status: "ok", item: "Aegis", detail: `${APP_VERSION} at ${root}` });

  // Chat model: which one will answer, and can this PC reach it?
  const provider = resolveProvider();
  const chatgpt = loadCredential(CODEX_CREDENTIAL);
  if (provider === "local") {
    add({
      status: "warn",
      item: "Chat model",
      detail: "none: Aegis can only list, read and search",
      fix: "/login chatgpt (your ChatGPT plan) · /login opencode <key> · or /model claude-code (your Claude plan)",
    });
  } else {
    const label =
      provider === "codex" ? `ChatGPT plan${chatgpt?.email ? ` (${chatgpt.email})` : ""}` : provider === "opencode" ? "OpenCode Zen key" : "OpenAI key";
    add({ status: "ok", item: "Chat model", detail: label });
    if (provider === "codex" && chatgpt && chatgpt.expires < Date.now()) {
      add({ status: "ok", item: "ChatGPT sign-in", detail: "token expired; it renews itself on the next turn" });
    }
    if (options.network !== false) {
      const url = provider === "codex" ? codexApiBase() : provider === "opencode" ? process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1" : "https://api.openai.com/v1";
      const ping = await reachable(url);
      add({
        status: ping.ok ? "ok" : "fail",
        item: "Network",
        detail: ping.ok ? `${new URL(url).host} reachable (${ping.detail})` : `${new URL(url).host}: ${ping.detail}`,
        fix: ping.ok ? undefined : "This PC cannot reach the chat service. Check the proxy (HTTPS_PROXY) or firewall.",
      });
    }
  }

  // Secrets on disk: only you should be able to read them.
  for (const [name, file] of [
    ["Sign-ins file", authFile()],
    ["Keys file", path.join(userAegisDir(), ".env")],
  ] as const) {
    if (!existsSync(file)) continue;
    const check = privateFile(file);
    add({
      status: check.ok ? "ok" : "warn",
      item: name,
      detail: `${file} · ${check.detail}`,
      fix: check.ok ? undefined : "Run /login again (it locks the file to your account), or: icacls <file> /inheritance:r /grant:r %USERNAME%:F",
    });
  }

  if (ignoredProjectEnv.size) {
    add({
      status: "warn",
      item: "Project .env",
      detail: `ignored: ${[...ignoredProjectEnv].sort().join(", ")}`,
      fix: "A project's .env may only set API keys and model names; put other settings in your own environment",
    });
  }

  // Claude Code engine.
  const claude = findClaude();
  if (claude) {
    const claudeVersion = version(claude);
    add({
      status: claudeVersion ? "ok" : "warn",
      item: "Claude Code",
      detail: claudeVersion ? `${claudeVersion} (${claude})` : `found at ${claude} but it did not start`,
      fix: claudeVersion ? undefined : "Run `claude` once in a terminal to finish its setup and sign in",
    });
    const hook = path.join(root, "scripts", "claude-hook.mjs");
    add({
      status: existsSync(hook) ? "ok" : "fail",
      item: "Claude Code lock",
      detail: existsSync(hook) ? "hook script present: every Claude Code tool call is checked by Aegis" : `missing ${hook}`,
      fix: existsSync(hook) ? undefined : "Reinstall Aegis; /model claude-code would refuse every tool call without it",
    });
  } else {
    add({ status: "ok", item: "Claude Code", detail: "not installed (optional: /model claude-code uses your Claude plan through it)" });
  }

  // Your rules.
  const loaded = loadSettingsSafe(cwd);
  if (loaded.error) {
    add({
      status: "fail",
      item: "Settings",
      detail: `${settingsPath(cwd)}: ${loaded.error}`,
      fix: "Fix the JSON. Until then Jev is off and allow rules are ignored (deny and ask still apply).",
    });
  } else {
    const rules = loaded.settings.rules;
    add({
      status: "ok",
      item: "Rules",
      detail: `${rules.deny.length} deny · ${rules.ask.length} ask · ${rules.allow.length} allow · Jev ${loaded.settings.jev.mode}${existsSync(settingsPath(cwd)) ? "" : " (defaults: no .aegis/settings.json here)"}`,
    });
  }

  // Shell.
  const shell = powershellExe();
  const shellVersion = version(shell, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
  add({
    status: shellVersion ? "ok" : process.platform === "win32" ? "warn" : "ok",
    item: "PowerShell",
    detail: shellVersion ? `${shell} ${shellVersion}` : process.platform === "win32" ? `${shell} not found` : "not installed (only needed on Windows)",
    fix: shellVersion || process.platform !== "win32" ? undefined : "Install PowerShell 7: winget install Microsoft.PowerShell",
  });
  add({
    status: "ok",
    item: "Agent shell",
    detail: shellAllowed() ? "on (AEGIS_ALLOW_SHELL=1): shell commands still pass your rules" : "off: the agent cannot run commands (you still can, with !cmd)",
  });

  // MCP servers (not started here).
  for (const server of mcpServers(cwd)) {
    add({
      status: server.trusted ? "ok" : "warn",
      item: `MCP ${server.name}`,
      detail: `${server.scope} · ${[server.command, ...(server.args ?? [])].join(" ")}`,
      fix: server.trusted ? undefined : `A project server: /mcp trust ${server.name} if you trust this repo`,
    });
  }

  // Terminal.
  if (process.platform === "win32" && process.stdout.isTTY) {
    const modern = Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM);
    add({
      status: modern ? "ok" : "warn",
      item: "Terminal",
      detail: modern ? "Windows Terminal (or a modern terminal)" : "classic console window",
      fix: modern ? undefined : "Windows Terminal draws the TUI best: winget install Microsoft.WindowsTerminal",
    });
  }
  return checks;
}

export function formatDoctor(checks: Check[]) {
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  const width = Math.max(...checks.map((check) => check.item.length));
  const lines = checks.map((check) => {
    const head = `${mark[check.status]} ${check.item.padEnd(width)}  ${check.detail}`;
    return check.fix ? `${head}\n  ${" ".repeat(width)}  → ${check.fix}` : head;
  });
  const fails = checks.filter((check) => check.status === "fail").length;
  const warns = checks.filter((check) => check.status === "warn").length;
  lines.push("", fails ? `${fails} problem(s) to fix, ${warns} warning(s).` : warns ? `Ready, with ${warns} warning(s).` : "All good.");
  return lines.join("\n");
}
