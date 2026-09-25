#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { headlessPrompt, runHeadless } from "./headless.ts";
import { formatDoctor, runDoctor } from "./doctor.ts";
import { openUrl } from "./open-url.ts";
import { startStudio } from "./studio.ts";
import { stdin, stdout } from "node:process";
import { APP_CMD, APP_VERSION } from "./brand.ts";
import { HELP } from "./commands.ts";
import { loadEnv } from "./env.ts";
import { queuedLines } from "./repl.ts";
import { closeState, handleLine, startState, welcomeInfo, type RunOpts } from "./runtime.ts";
import { welcomeLines } from "./welcome.ts";
import { loadUserTheme } from "./theme.ts";
import { runTui } from "./tui.ts";
import type { ConfirmAnswer, ConfirmFn } from "./types.ts";

export function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  const rest: string[] = [];
  let model: string | undefined;
  let port: number | undefined;
  const allow: string[] = [];
  const deny: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--allow" || arg === "--deny") {
      const rule = argv[i + 1];
      if (!rule) throw new Error(`${arg} needs a rule, e.g. ${arg} "shell npm test"`);
      (arg === "--allow" ? allow : deny).push(rule);
      i += 1;
      continue;
    }
    if (arg === "--model" || arg === "-m") {
      model = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }
    if (arg === "--port") {
      port = Number(argv[i + 1]);
      i += 1;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port needs a number from 0 to 65535");
      continue;
    }
    if (arg.startsWith("--") || /^-[a-z]$/i.test(arg)) flags.add(arg);
    else rest.push(arg);
  }
  return {
    mockJev: flags.has("--mock-jev"),
    yes: flags.has("--yes"),
    local: flags.has("--local"),
    help: flags.has("--help") || flags.has("-h"),
    version: flags.has("--version") || flags.has("-v"),
    continue: flags.has("--continue") || flags.has("-c"),
    noOpen: flags.has("--no-open"),
    port,
    repl: flags.has("--repl"),
    print: flags.has("-p") || flags.has("--print"),
    json: flags.has("--json"),
    stdin: flags.has("--stdin"),
    tui: flags.has("--tui"),
    trustProject: flags.has("--trust-project"),
    allow,
    deny,
    model,
    prompt: rest.join(" ").trim(),
  };
}

function help() {
  return [
    `${APP_CMD} ${APP_VERSION} — the coding agent you own. Rules decide first; plugins add the rest.`,
    "",
    "  aegis                      start in this folder (new session)",
    "  aegis -c                   continue the last session here",
    "  aegis \"a question\"         answer once and exit",
    "  aegis doctor               is this PC ready? one line per check, with the fix",
    "  aegis ui                   open Aegis Studio in your browser (same sessions, rules and plugins)",
    "  aegis -p \"task\"            headless: rules decide, nothing asks you; prints the answer",
    "  aegis -p --json \"task\"     one JSON object per line: every event, then the result",
    "",
    "Flags: -c, --continue   continue the last session instead of starting a new one",
    "       -m, --model <id> pin this model for the session",
    "       --repl           plain prompt (pipes, scripts). A terminal opens the TUI",
    "       --local          no chat model: list, read and search only",
    "       -p, --print      headless (exit 0 done, 1 error, 2 a tool call was denied); --json for JSON lines",
    "       --stdin          with -p and a task: also read stdin (without a task, stdin is the task)",
    "       --allow <rule>   with -p: allow this for this run only, e.g. --allow \"shell npm test\" (repeatable)",
    "       --deny <rule>    deny this for this run only (repeatable)",
    "       --trust-project  use this folder's .aegis/settings.json allow rules without /trust (CI you control)",
    "       --yes            with -p: approve every question (dangerous: only rules you trust should decide)",
    "       -v, --version    print the version",
    "       --port <n>       aegis ui: port to listen on (default: a free one)",
    "       --no-open        aegis ui: print the link without opening the browser",
    "       -h, --help       this help",
    "       --yes            auto-approve y/N prompts (tests only)",
    "       --mock-jev       fake Jev scores (tests only)",
    "",
    HELP,
  ].join("\n");
}

export function createConfirm(input: {
  yes?: boolean;
  answers?: string[];
}): ConfirmFn {
  const read = (answer: string, always?: string): ConfirmAnswer =>
    always && /^a(lways)?$/i.test(answer.trim()) ? "always" : /^y(es)?$/i.test(answer.trim());
  return async (question, options) => {
    if (input.yes) return true;
    if (input.answers) return read(input.answers.shift() ?? "n", options?.always);
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const hint = options?.always ? `(a = always allow: ${options.always}) ` : "";
      const answer = await rl.question(`${question}${hint}`);
      return read(answer, options?.always);
    } finally {
      rl.close();
    }
  };
}

async function repl(opts: RunOpts) {
  const cwd = process.cwd();
  const state = await startState(cwd, opts);
  loadUserTheme();
  const color = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
  console.log(welcomeLines(await welcomeInfo(state), stdout.columns || 100, color).join("\n"));
  const rl = createInterface({ input: stdin, output: stdout, prompt: "aegis> " });
  const nextLine = queuedLines(rl);
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const showPrompt = () => {
    if (closed || stdin.readableEnded) return;
    rl.prompt();
  };
  let abort = new AbortController();
  rl.on("SIGINT", () => abort.abort());
  const confirm = createConfirm(opts);
  showPrompt();
  while (true) {
    const line = await nextLine();
    if (line === null) break;
    abort = new AbortController();
    rl.pause();
    const result = await handleLine(line, state, { ...opts, abortSignal: abort.signal }, confirm, (event) => {
      if (event.type === "notice") console.log(event.text);
    });
    rl.resume();
    if (result.notice) console.error(result.notice);
    if (result.output) console.log(result.output);
    if (result.exit) break;
    showPrompt();
  }
  closeState(state);
  if (!closed) rl.close();
}

/** `aegis ui`: serve Studio on 127.0.0.1, open the browser, run until ctrl+c. Continues the last session. */
async function runStudio(opts: RunOpts, input: { port?: number; open: boolean; fresh: boolean }) {
  const studio = await startStudio({ cwd: process.cwd(), opts, port: input.port, continueSession: !input.fresh });
  console.log(`Aegis Studio  ${studio.url}`);
  console.log("Runs on this PC only (127.0.0.1). The link carries a one-time key; keep it private. ctrl+c stops.");
  if (input.open) openUrl(studio.url, () => console.log("Open the link above in your browser."));
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await studio.close();
}

function wantTui(args: { tui: boolean; repl: boolean; prompt: string }) {
  if (args.prompt) return false;
  if (args.repl) return false;
  if (args.tui) return true;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/**
 * First Ctrl+C stops the run gracefully; a second one exits at once, through process.exit so the process groups
 * Aegis started (detached on Linux/macOS, so the terminal's Ctrl+C does not reach them) are killed on the way out.
 */
function onCtrlC(abort: AbortController) {
  process.once("SIGINT", () => {
    abort.abort();
    process.once("SIGINT", () => process.exit(130));
  });
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(`${APP_CMD} ${APP_VERSION}`);
    return;
  }
  // Only from the command line or the real environment; a project's .env cannot set it (see env.ts).
  if (args.trustProject) process.env.AEGIS_TRUST_PROJECT = "1";
  // Rules for this run only (like Claude Code's --allowedTools); never saved, and the floor still wins.
  if (args.allow.length || args.deny.length) process.env.AEGIS_RUN_RULES = JSON.stringify({ allow: args.allow, deny: args.deny });
  loadEnv();
  if (args.help) {
    console.log(help());
    return;
  }
  const opts: RunOpts = {
    mockJev: args.mockJev,
    yes: args.yes,
    local: args.local,
    model: args.model,
    // Like Pi and Claude Code: every launch is a new session; -c continues the last one.
    newSession: !args.continue,
  };
  if (args.print) {
    const abort = new AbortController();
    onCtrlC(abort);
    const prompt = await headlessPrompt(args.prompt, stdin, args.stdin);
    if (!prompt) {
      console.error('usage: aegis -p "task"   (or pipe the task in)');
      process.exitCode = 1;
      return;
    }
    process.exitCode = await runHeadless({
      prompt,
      cwd: process.cwd(),
      opts,
      json: args.json,
      write: (text) => stdout.write(`${text}\n`),
      abortSignal: abort.signal,
    });
    return;
  }
  if (args.prompt === "doctor") {
    const checks = await runDoctor(process.cwd());
    console.log(formatDoctor(checks));
    process.exitCode = checks.some((check) => check.status === "fail") ? 1 : 0;
    return;
  }
  if (args.prompt === "ui" || args.prompt === "studio") {
    await runStudio({ ...opts, newSession: false }, { port: args.port, open: !args.noOpen, fresh: false });
    return;
  }
  if (args.prompt) {
    const abort = new AbortController();
    onCtrlC(abort);
    const state = await startState(process.cwd(), opts);
    try {
      const result = await handleLine(args.prompt, state, { ...opts, abortSignal: abort.signal }, createConfirm(opts));
      if (result.notice) console.error(result.notice);
      if (result.output) console.log(result.output);
    } finally {
      closeState(state);
    }
    return;
  }
  if (wantTui(args)) {
    await runTui(opts);
    return;
  }
  await repl(opts);
}

// Dev entry (tsx src/cli.ts). The installed command runs src/main.ts → dist/main.js.
const launched = process.argv[1]?.replaceAll("\\", "/").endsWith("/cli.ts");
if (launched) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
