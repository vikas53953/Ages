/**
 * End-to-end checks for slices 1–4, run against the real runtime on the real machine.
 * Replaces the manual Windows test list: y/N prompts are answered by the script and every prompt is recorded.
 *
 *   npm run check:windows                     scripted model (no keys needed)
 *   $env:OPENCODE_API_KEY="…"; npm run check:windows   adds live-model checks
 *
 * Writes windows-check-report.md (or the path in AEGIS_CHECK_REPORT) and exits 1 if any check fails.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { loadSummary } from "../src/compact.ts";
import { generateWith } from "../src/loop.ts";
import { handleLine, startState, type AppState, type RunOpts } from "../src/runtime.ts";
import { settingsPath } from "../src/rules.ts";
import { loadMessages, messageText } from "../src/session.ts";
import { powershellExe, runPowerShell } from "../src/tools/fs.ts";

type Outcome = { status: "pass" | "fail" | "skip"; detail: string };
type Check = { id: string; slice: string; title: string; run: () => Promise<string> };

class Skip extends Error {}

const isWindows = process.platform === "win32";
const liveKey = Boolean(process.env.OPENCODE_API_KEY);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function short(text: string, max = 300) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function folder(name: string, settings?: object) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `aegis-check-${name}-`));
  await writeFile(path.join(cwd, "README.md"), "AEGIS-CHECK-FIRST-LINE\nsecond line\n", "utf8");
  if (settings) {
    await mkdir(path.join(cwd, ".aegis"), { recursive: true });
    await writeFile(settingsPath(cwd), JSON.stringify(settings, null, 2), "utf8");
  }
  return cwd;
}

// ── scripted model: each model call takes the next step ───────────────────────────
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type Step = { tool: string; input: object } | { text: string };

function scripted(steps: Step[], prompts: string[] = []) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const step = steps[index++] ?? { text: "done" };
      const chunks =
        "tool" in step
          ? [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: `call-${index}`,
                toolName: step.tool,
                input: JSON.stringify(step.input),
              },
              { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage },
            ]
          : [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: step.text },
              { type: "text-end" as const, id: "t" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

function opts(model?: MockLanguageModelV4, extra: Partial<RunOpts> = {}): RunOpts {
  return { mockJev: true, yes: false, local: true, generate: model ? generateWith(model) : undefined, ...extra };
}

/** A y/N answerer that records every question. */
function answers(...replies: boolean[]) {
  const asked: string[] = [];
  const confirm = async (question: string) => {
    asked.push(question);
    return replies.shift() ?? false;
  };
  return { asked, confirm };
}

async function start(cwd: string, local = true): Promise<AppState> {
  return startState(cwd, { local, mockJev: true });
}

// ── the checks ────────────────────────────────────────────────────────────────
const checks: Check[] = [
  {
    id: "1",
    slice: "1",
    title: "A read works with no Jev scoring (rule allow: read *)",
    run: async () => {
      const cwd = await folder("read");
      const state = await start(cwd);
      const model = scripted([{ tool: "read", input: { path: "README.md" } }, { text: "read it" }]);
      const out = await handleLine("read README.md", state, opts(model));
      assert(out.receipt?.tools[0]?.approved, `read was not run: ${short(out.output)}`);
      assert(out.receipt?.tools[0]?.source === "rule", `decided by ${out.receipt?.tools[0]?.source}, expected rule`);
      return `tool read ran, decided by rule "${out.receipt?.tools[0]?.rule}"`;
    },
  },
  {
    id: "2",
    slice: "1",
    title: "/jev every → off is saved to .aegis/settings.json; /status shows it",
    run: async () => {
      const cwd = await folder("jev");
      const state = await start(cwd);
      await handleLine("/jev every", state, opts());
      const every = JSON.parse(await readFile(settingsPath(cwd), "utf8"));
      assert(every.jev.mode === "every-call", `after /jev every the file says ${every.jev.mode}`);
      await handleLine("/jev off", state, opts());
      const off = JSON.parse(await readFile(settingsPath(cwd), "utf8"));
      assert(off.jev.mode === "off", `after /jev off the file says ${off.jev.mode}`);
      const status = (await handleLine("/status", state, opts())).output;
      assert(/jev\s+off\s+\(mode off\)/.test(status), `/status: ${short(status)}`);
      return "file and /status both show mode off";
    },
  },
  {
    id: "3",
    slice: "1",
    title: "Real PowerShell: Remove-Item asks first (rule), n keeps the folder, y deletes it",
    run: async () => {
      if (!isWindows) throw new Skip("not Windows");
      const cwd = await folder("shell");
      await mkdir(path.join(cwd, "testdir"));
      await writeFile(path.join(cwd, "testdir", "keep.txt"), "x", "utf8");
      const previous = process.env.AEGIS_ALLOW_SHELL;
      process.env.AEGIS_ALLOW_SHELL = "1";
      try {
        const state = await start(cwd);
        const call = { tool: "shell", input: { command: "Remove-Item -Recurse testdir" } };
        const no = answers(false);
        await handleLine("delete testdir", state, opts(scripted([call, { text: "ok" }])), no.confirm);
        assert(no.asked.length === 1, `expected 1 prompt, got ${no.asked.length}`);
        assert(no.asked[0]!.includes('rule "shell Remove-Item*" → ask'), `prompt: ${short(no.asked[0]!)}`);
        assert(existsSync(path.join(cwd, "testdir")), "testdir was deleted after answering n");
        const yes = answers(true);
        await handleLine("delete testdir", state, opts(scripted([call, { text: "ok" }])), yes.confirm);
        assert(!existsSync(path.join(cwd, "testdir")), "testdir still exists after answering y (PowerShell did not run?)");
      } finally {
        if (previous === undefined) delete process.env.AEGIS_ALLOW_SHELL;
        else process.env.AEGIS_ALLOW_SHELL = previous;
      }
      return "prompt showed the rule; n kept testdir; y ran Remove-Item in PowerShell";
    },
  },
  {
    id: "3b",
    slice: "1",
    title: "Shell stays off without AEGIS_ALLOW_SHELL=1",
    run: async () => {
      const cwd = await folder("shelloff");
      await mkdir(path.join(cwd, "testdir"));
      const previous = process.env.AEGIS_ALLOW_SHELL;
      delete process.env.AEGIS_ALLOW_SHELL;
      try {
        const state = await start(cwd);
        const yes = answers(true);
        const call = { tool: "shell", input: { command: "Remove-Item -Recurse testdir" } };
        await handleLine("delete testdir", state, opts(scripted([call, { text: "ok" }])), yes.confirm);
        assert(existsSync(path.join(cwd, "testdir")), "testdir was deleted with shell off");
      } finally {
        if (previous !== undefined) process.env.AEGIS_ALLOW_SHELL = previous;
      }
      return "testdir kept; shell refused";
    },
  },
  {
    id: "4",
    slice: "1",
    title: "Writes into .git are denied, with / and \\ paths",
    run: async () => {
      const cwd = await folder("git");
      await mkdir(path.join(cwd, ".git"));
      const state = await start(cwd);
      const yes = answers(true, true);
      const model = scripted([
        { tool: "write", input: { path: ".git/test.txt", contents: "hello" } },
        { tool: "write", input: { path: ".git\\test2.txt", contents: "hello" } },
        { text: "tried" },
      ]);
      const out = await handleLine("write into git", state, opts(model), yes.confirm);
      const tools = out.receipt?.tools ?? [];
      assert(tools.length === 2, `expected 2 tool calls, got ${tools.length}`);
      assert(tools.every((tool) => tool.deniedReason === "rule: write .git/*"), JSON.stringify(tools.map((t) => t.deniedReason)));
      assert(yes.asked.length === 0, "you were asked; a deny rule should block without asking");
      assert(!existsSync(path.join(cwd, ".git", "test.txt")) && !existsSync(path.join(cwd, ".git", "test2.txt")), "a file was written into .git");
      return "both denied by rule, no prompt, nothing written";
    },
  },
  {
    id: "5",
    slice: "2",
    title: "Turn 2 still sees what the read tool returned in turn 1",
    run: async () => {
      const cwd = await folder("memory");
      const state = await start(cwd);
      const prompts: string[] = [];
      const model = scripted(
        [{ tool: "read", input: { path: "README.md" } }, { text: "read it" }, { text: "The first line is AEGIS-CHECK-FIRST-LINE." }],
        prompts,
      );
      await handleLine("read README.md", state, opts(model));
      const second = await handleLine("what is the first line? do not read again", state, opts(model));
      assert(prompts[2]?.includes("AEGIS-CHECK-FIRST-LINE"), "turn 2 request did not carry the turn 1 tool result");
      assert((second.receipt?.tools.length ?? 0) === 0, "turn 2 ran a tool");
      return "turn 2 request contained the file text from turn 1's tool result";
    },
  },
  {
    id: "6",
    slice: "2",
    title: "After a restart the session still has the tool result",
    run: async () => {
      const cwd = await folder("restart");
      const first = await start(cwd);
      await handleLine("read README.md", first, opts(scripted([{ tool: "read", input: { path: "README.md" } }, { text: "ok" }])));
      const prompts: string[] = [];
      const again = await start(cwd); // like closing and reopening aegis
      assert(again.session.id === first.session.id, "a new session was started instead of resuming");
      await handleLine("what was the first line?", again, opts(scripted([{ text: "It was AEGIS-CHECK-FIRST-LINE." }], prompts)));
      assert(prompts[0]?.includes("AEGIS-CHECK-FIRST-LINE"), "reopened session did not send the old tool result");
      const rows = await loadMessages(cwd, again.session.id);
      return `session ${again.session.id} resumed with ${rows.length} saved rows`;
    },
  },
  {
    id: "7",
    slice: "3",
    title: "/compact folds old turns into summary.md and the summary reaches the model",
    run: async () => {
      const cwd = await folder("compact");
      const state = await start(cwd);
      for (let i = 1; i <= 5; i++) {
        await handleLine(`question ${i} about topic-${i}`, state, opts(scripted([{ text: `answer ${i}` }])));
      }
      const compact = await handleLine("/compact", state, opts(undefined, { summarize: async ({ transcript }) => `SUMMARY: ${short(transcript, 400)}` }));
      assert(/compacted \d+ messages into .*summary\.md \(model\)/.test(compact.output), `/compact said: ${short(compact.output)}`);
      const summary = await loadSummary(cwd, state.session.id);
      assert(summary.includes("topic-1"), `summary.md: ${short(summary)}`);
      const prompts: string[] = [];
      await handleLine("what did we do earlier?", state, opts(scripted([{ text: "recap" }], prompts)));
      assert(prompts[0]?.includes("Earlier in this session (compacted summary"), "summary not in the system prompt");
      return short(compact.output, 160);
    },
  },
  {
    id: "7b",
    slice: "3",
    title: "Auto-compaction runs when history passes compactAtChars",
    run: async () => {
      const cwd = await folder("autocompact");
      await writeFile(path.join(cwd, "gate.config.json"), JSON.stringify({ compactAtChars: 200, compactKeepTurns: 1 }), "utf8");
      const state = await start(cwd);
      const notices: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const out = await handleLine(`turn ${i} ${"x".repeat(60)}`, state, opts(scripted([{ text: `reply ${i} ${"y".repeat(60)}` }])));
        if (out.notice) notices.push(out.notice);
      }
      const auto = notices.find((notice) => notice.includes("Auto-compacted"));
      assert(auto, `no auto-compaction notice: ${JSON.stringify(notices)}`);
      return short(auto.split("\n").find((line) => line.includes("Auto-compacted")) ?? auto, 160);
    },
  },
  {
    id: "8",
    slice: "4",
    title: "/help lists plugin commands; /status lists plugins",
    run: async () => {
      const cwd = await folder("help");
      const state = await start(cwd);
      const help = (await handleLine("/help", state, opts())).output;
      const status = (await handleLine("/status", state, opts())).output;
      assert(help.includes("Plugins:") && help.includes("/task confirm") && help.includes("/jev off|second|every"), short(help));
      assert(status.includes("plugins   jev, delivery, receipts"), short(status));
      return "Plugins section present; plugins jev, delivery, receipts";
    },
  },
  {
    id: "9",
    slice: "4",
    title: 'With "plugins": [] the core still runs; /task and /jev are gone',
    run: async () => {
      const cwd = await folder("noplugins", { plugins: [] });
      const state = await start(cwd);
      assert(state.jevHealth === "off", `footer jev = ${state.jevHealth}`);
      const task = (await handleLine("/task", state, opts())).output;
      assert(task.includes("unknown command /task"), short(task));
      const turn = await handleLine("read README.md", state, opts(scripted([{ tool: "read", input: { path: "README.md" } }, { text: "ok" }])));
      assert(turn.receipt?.tools[0]?.approved, "read did not run with no plugins");
      assert(!existsSync(path.join(cwd, ".harness", "receipts")), "receipts were written without the receipts plugin");
      return "jev off, /task unknown, read ran, no receipts folder";
    },
  },
  {
    id: "10",
    slice: "UX",
    title: "!command runs PowerShell yourself (pwsh preferred) and the output joins the chat",
    run: async () => {
      if (!isWindows) throw new Skip("not Windows");
      const cwd = await folder("bang");
      const state = await start(cwd);
      const out = await handleLine("!Get-ChildItem -Name", state, opts());
      assert(out.output.includes("README.md"), `output: ${short(out.output)}`);
      const rows = await loadMessages(cwd, state.session.id);
      assert(rows.some((row) => messageText(row).includes("I ran this PowerShell command myself")), "output not added to the chat");
      return `${powershellExe()} ran it; output added to the chat`;
    },
  },
  {
    id: "11",
    slice: "UX",
    title: "Each launch is a new session; -c (no newSession) continues the last one",
    run: async () => {
      const cwd = await folder("launch");
      const a = await startState(cwd, { local: true, mockJev: true, newSession: true });
      const b = await startState(cwd, { local: true, mockJev: true, newSession: true });
      const c = await startState(cwd, { local: true, mockJev: true });
      assert(a.session.id !== b.session.id, "two launches shared a session");
      assert(c.session.id === b.session.id, "continue did not pick the last session");
      return "new, new, continued";
    },
  },
  {
    id: "L1",
    slice: "2 live",
    title: "Live model remembers a file it read last turn (OpenCode)",
    run: async () => {
      if (!liveKey) throw new Skip("no OPENCODE_API_KEY");
      const cwd = await folder("live");
      const state = await start(cwd, false);
      const live: RunOpts = { mockJev: true, yes: false, local: false };
      await handleLine("Read README.md with the read tool, then say 'done'.", state, live);
      const second = await handleLine(
        "Without using any tool, what is the exact first line of README.md?",
        state,
        live,
      );
      const text = second.receipt?.text ?? second.output;
      assert(text.includes("AEGIS-CHECK-FIRST-LINE"), `answer: ${short(text)}`);
      return `answered from memory; tools in turn 2: ${second.receipt?.tools.length ?? 0}`;
    },
  },
  {
    id: "L2",
    slice: "3 live",
    title: "Live model writes the compaction summary (OpenCode)",
    run: async () => {
      if (!liveKey) throw new Skip("no OPENCODE_API_KEY");
      const cwd = await folder("livecompact");
      const state = await start(cwd, false);
      for (let i = 1; i <= 4; i++) {
        await handleLine(`Remember code word ${i}: WORD-${i}. Reply with just OK.`, state, { mockJev: true, yes: false, local: false });
      }
      const out = await handleLine("/compact", state, { mockJev: true, yes: false, local: false });
      assert(out.output.includes("(model)"), short(out.output));
      return short(out.output, 160);
    },
  },
];

async function environment() {
  const lines = [`node ${process.version}`, `platform ${process.platform} ${os.release()}`];
  if (isWindows) {
    try {
      const { stdout } = await runPowerShell("$PSVersionTable.PSVersion.ToString()", process.cwd(), 15_000);
      lines.push(`PowerShell ${stdout.trim()}`);
    } catch (error) {
      lines.push(`PowerShell: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  lines.push(`live model checks: ${liveKey ? "on" : "off (no OPENCODE_API_KEY)"}`);
  return lines;
}

async function main() {
  const results: Array<Check & Outcome> = [];
  for (const check of checks) {
    let outcome: Outcome;
    try {
      outcome = { status: "pass", detail: await check.run() };
    } catch (error) {
      outcome =
        error instanceof Skip
          ? { status: "skip", detail: error.message }
          : { status: "fail", detail: error instanceof Error ? error.message : String(error) };
    }
    results.push({ ...check, ...outcome });
    const mark = outcome.status === "pass" ? "PASS" : outcome.status === "skip" ? "SKIP" : "FAIL";
    console.log(`${mark}  ${check.id.padEnd(3)} ${check.title}\n      ${outcome.detail}`);
  }
  const failed = results.filter((row) => row.status === "fail").length;
  const passed = results.filter((row) => row.status === "pass").length;
  const skipped = results.filter((row) => row.status === "skip").length;
  const report = [
    "# Aegis Windows check",
    "",
    `**${failed ? "FAILED" : "PASSED"}** — ${passed} pass, ${failed} fail, ${skipped} skip · ${new Date().toISOString()}`,
    "",
    ...(await environment()).map((line) => `- ${line}`),
    "",
    "| # | Slice | Check | Result | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      (row) =>
        `| ${row.id} | ${row.slice} | ${row.title} | ${row.status.toUpperCase()} | ${row.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
    ),
    "",
    "Not covered here: how the TUI looks in a live Windows Terminal (paste, resize). The TUI logic runs in the Vitest suite.",
    "",
  ].join("\n");
  const file = process.env.AEGIS_CHECK_REPORT || path.resolve("windows-check-report.md");
  await writeFile(file, report, "utf8");
  console.log(`\n${passed} pass, ${failed} fail, ${skipped} skip. Report: ${file}`);
  process.exitCode = failed ? 1 : 0;
}

await main();
