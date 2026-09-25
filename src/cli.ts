#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { APP_CMD, APP_VERSION } from "./brand.ts";
import { HELP } from "./commands.ts";
import { loadEnv } from "./env.ts";
import { queuedLines } from "./repl.ts";
import { handleLine, startState, welcomeInfo, type RunOpts } from "./runtime.ts";
import { welcomeLines } from "./welcome.ts";
import { loadUserTheme } from "./theme.ts";
import { runTui } from "./tui.ts";
import type { ConfirmAnswer, ConfirmFn } from "./types.ts";

export function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  const rest: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--model" || arg === "-m") {
      model = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
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
    repl: flags.has("--repl"),
    tui: flags.has("--tui"),
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
    "",
    "Flags: -c, --continue   continue the last session instead of starting a new one",
    "       -m, --model <id> pin this model for the session",
    "       --repl           plain prompt (pipes, scripts). A terminal opens the TUI",
    "       --local          no chat model: list, read and search only",
    "       -v, --version    print the version",
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
    const result = await handleLine(line, state, { ...opts, abortSignal: abort.signal }, confirm);
    rl.resume();
    if (result.notice) console.error(result.notice);
    if (result.output) console.log(result.output);
    if (result.exit) break;
    showPrompt();
  }
  if (!closed) rl.close();
}

function wantTui(args: { tui: boolean; repl: boolean; prompt: string }) {
  if (args.prompt) return false;
  if (args.repl) return false;
  if (args.tui) return true;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(`${APP_CMD} ${APP_VERSION}`);
    return;
  }
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
  if (args.prompt) {
    const abort = new AbortController();
    process.once("SIGINT", () => abort.abort());
    const state = await startState(process.cwd(), opts);
    const result = await handleLine(args.prompt, state, { ...opts, abortSignal: abort.signal }, createConfirm(opts));
    if (result.notice) console.error(result.notice);
    if (result.output) console.log(result.output);
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
