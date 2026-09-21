#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { HELP } from "./commands.ts";
import { loadEnv } from "./env.ts";
import { queuedLines } from "./repl.ts";
import { handleLine, startState, type RunOpts } from "./runtime.ts";
import { runTui } from "./tui.ts";
import type { ConfirmFn } from "./types.ts";

function parseArgs(argv: string[]) {
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
    if (arg.startsWith("--")) flags.add(arg);
    else rest.push(arg);
  }
  return {
    mockJev: flags.has("--mock-jev"),
    yes: flags.has("--yes"),
    local: flags.has("--local"),
    help: flags.has("--help") || flags.has("-h"),
    repl: flags.has("--repl"),
    tui: flags.has("--tui"),
    model,
    prompt: rest.join(" ").trim(),
  };
}

function help() {
  return [
    "aegis — the agent you own. Jev locks spend and danger.",
    "",
    "  aegis",
    "  aegis \"what files are in this folder?\"",
    "",
    HELP,
    "",
    "Flags: --yes        auto-approve danger prompts (tests)",
    "       --local      skip OpenCode; list/read/search only",
    "       --model <id> pin this model for the session",
    "       --mock-jev   tests only; otherwise missing Jev keys fail-closed",
    "       --repl       plain prompt. TTY opens the TUI",
  ].join("\n");
}

export function createConfirm(input: {
  yes?: boolean;
  answers?: string[];
}): ConfirmFn {
  return async (question) => {
    if (input.yes) return true;
    if (input.answers) {
      const next = input.answers.shift() ?? "n";
      return /^y(es)?$/i.test(next.trim());
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(question);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

async function repl(opts: RunOpts) {
  const cwd = process.cwd();
  const state = await startState(cwd, opts);
  console.log(`Aegis  ${state.model}  ${state.provider}`);
  console.log(`session ${state.session.id}  cwd ${cwd}`);
  console.log("/models to list. /model <id> to switch. /exit to quit.");
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
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

const launched = process.argv[1]?.replaceAll("\\", "/").endsWith("/cli.ts");
if (launched) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
