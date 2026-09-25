#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { APP_CMD, APP_VERSION } from "./brand.js";
import { HELP } from "./commands.js";
import { loadEnv } from "./env.js";
import { queuedLines } from "./repl.js";
import { handleLine, startState, welcomeInfo } from "./runtime.js";
import { welcomeLines } from "./welcome.js";
import { runTui } from "./tui.js";
function parseArgs(argv) {
    const flags = new Set();
    const rest = [];
    let model;
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
        if (arg.startsWith("--"))
            flags.add(arg);
        else
            rest.push(arg);
    }
    return {
        mockJev: flags.has("--mock-jev"),
        yes: flags.has("--yes"),
        local: flags.has("--local"),
        help: flags.has("--help") || flags.has("-h"),
        version: flags.has("--version") || flags.has("-v"),
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
        "       --mock-jev   tests only; without a Jev key, unmatched calls ask you",
        "       --repl       plain prompt. TTY opens the TUI",
    ].join("\n");
}
export function createConfirm(input) {
    return async (question) => {
        if (input.yes)
            return true;
        if (input.answers) {
            const next = input.answers.shift() ?? "n";
            return /^y(es)?$/i.test(next.trim());
        }
        const rl = createInterface({ input: stdin, output: stdout });
        try {
            const answer = await rl.question(question);
            return /^y(es)?$/i.test(answer.trim());
        }
        finally {
            rl.close();
        }
    };
}
async function repl(opts) {
    const cwd = process.cwd();
    const state = await startState(cwd, opts);
    const color = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
    console.log(welcomeLines(await welcomeInfo(state), stdout.columns || 100, color).join("\n"));
    const rl = createInterface({ input: stdin, output: stdout, prompt: "aegis> " });
    const nextLine = queuedLines(rl);
    let closed = false;
    rl.on("close", () => {
        closed = true;
    });
    const showPrompt = () => {
        if (closed || stdin.readableEnded)
            return;
        rl.prompt();
    };
    let abort = new AbortController();
    rl.on("SIGINT", () => abort.abort());
    const confirm = createConfirm(opts);
    showPrompt();
    while (true) {
        const line = await nextLine();
        if (line === null)
            break;
        abort = new AbortController();
        rl.pause();
        const result = await handleLine(line, state, { ...opts, abortSignal: abort.signal }, confirm);
        rl.resume();
        if (result.notice)
            console.error(result.notice);
        if (result.output)
            console.log(result.output);
        if (result.exit)
            break;
        showPrompt();
    }
    if (!closed)
        rl.close();
}
function wantTui(args) {
    if (args.prompt)
        return false;
    if (args.repl)
        return false;
    if (args.tui)
        return true;
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
    const opts = {
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
        if (result.notice)
            console.error(result.notice);
        if (result.output)
            console.log(result.output);
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
