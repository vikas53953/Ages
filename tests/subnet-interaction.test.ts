import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
  formatTaskSystemPrompt,
  loadTask,
  writeAgreement,
  type Agreement,
} from "../src/plugins/delivery/delivery.ts";
import { formatTurnHandoff } from "../src/receipt.ts";
import { classifyTurnOutcome, createTools, runLoop, type TurnEvent } from "../src/loop.ts";
import { mockJev } from "../src/plugins/jev/mock.ts";
import { handleLine, jevHealthFromReceipt, startState } from "../src/runtime.ts";
import { loadMessages, messageText } from "../src/session.ts";
import { createTuiApp, type TuiApp } from "../src/tui-app.ts";
import { MemoryTerminal } from "../src/tui-memory.ts";
import type { Receipt } from "../src/types.ts";
import { loadPlugins } from "../src/plugins/index.ts";
import { toolGuards } from "../src/plugin-api.ts";

const shipped = () => loadPlugins(["jev", "delivery", "receipts"], { mockJev: true }).plugins;


const localOpts = { toolCallId: "t1", messages: [], context: {} } as never;

const taskA = (id = "controlled-delivery"): Agreement => ({
  id,
  objective: "Implement controlled delivery with inspectable evidence.",
  scope: ["delivery"],
  acceptance: [{ id: "c1", text: "Keep the existing engine." }],
  exclusions: ["agent fleet"],
  status: "proposed",
});

async function waitFor(app: TuiApp, needle: string, ms = 4000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const text = [app.messages().join("\n"), app.lines().join("\n")].join("\n");
    if (text.includes(needle)) return text;
    app.tui.renderNow(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`missing ${JSON.stringify(needle)}\n${app.messages().join("\n")}\n${app.lines().join("\n")}`);
}

describe("subnet-calculator interaction", () => {
  const apps: TuiApp[] = [];
  afterEach(() => {
    while (apps.length) apps.pop()?.shutdown();
  });

  it("surfaces the wrong active agreement, preserves it, and does not silently confirm", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-subnet-a-"));
    await writeAgreement(cwd, taskA());
    const state = await startState(cwd, { local: true, mockJev: true });
    const shown = await handleLine("/task", state, { mockJev: true, yes: true, local: true });
    expect(shown.output).toContain("controlled-delivery");
    expect(shown.output).toContain("proposed");
    const created = await handleLine("/task new subnet-calculator", state, {
      mockJev: true,
      yes: true,
      local: true,
    });
    expect(created.output).toContain("The active task is unchanged");
    const drafted = await handleLine(
      "Build a tiny browser-based subnet calculator for networking students.",
      state,
      { mockJev: true, yes: true, local: true },
    );
    expect(drafted.output).toContain("Proposed 'subnet-calculator'");
    expect(drafted.output).toContain("Active task was not overwritten");
    expect(drafted.output).toContain("Proposed agreement for review");
    expect(drafted.output).toContain("Build a tiny browser-based subnet calculator");
    expect(drafted.output).not.toContain("Keep the existing engine.");
    expect(drafted.output).toContain("Preserved active task");
    expect(drafted.output).toContain("controlled-delivery");
    const original = JSON.parse(
      await readFile(path.join(cwd, ".harness", "task", "agreement.json"), "utf8"),
    ) as { id: string; status: string };
    expect(original.id).toBe("controlled-delivery");
    expect(original.status).toBe("proposed");
    const yes = await handleLine("yes", state, { mockJev: true, yes: true, local: true });
    expect(yes.output).toContain("subnet-calculator");
    expect(yes.output).toContain("confirmed");
    const leftover = JSON.parse(
      await readFile(path.join(cwd, ".harness", "task", "agreement.json"), "utf8"),
    ) as { id: string; status: string };
    expect(leftover.id).toBe("controlled-delivery");
    expect(leftover.status).toBe("proposed");
    const active = await loadTask(cwd);
    expect(active?.agreement.id).toBe("subnet-calculator");
    expect(active?.agreement.status).toBe("confirmed");
  });

  it("explains ambiguous yes instead of entering a blocked generation loop", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-subnet-yes-"));
    await writeAgreement(cwd, taskA());
    const state = await startState(cwd, { local: true, mockJev: true });
    let generated = 0;
    const result = await handleLine("yes", state, { mockJev: true, yes: true, local: true });
    expect(result.output).toContain("Plain yes did not confirm");
    expect(result.output).toContain("controlled-delivery");
    expect(result.receipt).toBeUndefined();
    const tools = createTools({
      cwd,
      guards: toolGuards(shipped()),
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => true,
      onTool: () => {
        generated += 1;
      },
    });
    const denied = String(await tools.write.execute!({ path: "subnet/index.html", contents: "x" }, localOpts));
    expect(denied).toContain("unconfirmed delivery agreement");
    expect(denied).toContain("controlled-delivery");
    await expect(readFile(path.join(cwd, "subnet", "index.html"), "utf8")).rejects.toThrow();
  });

  it("stops further model/tool attempts after a terminal agreement denial", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-subnet-stop-"));
    await writeAgreement(cwd, taskA());
    let toolCalls = 0;
    let jevTools = 0;
    const jev = mockJev();
    const wrapped = {
      evaluateTurn: jev.evaluateTurn.bind(jev),
      evaluateTool: async (...args: Parameters<typeof jev.evaluateTool>) => {
        jevTools += 1;
        return jev.evaluateTool(...args);
      },
    };
    const events: TurnEvent["type"][] = [];
    const receipt = await runLoop({
      plugins: shipped(),
      cwd,
      prompt: "yes, build the subnet calculator",
      jev: wrapped,
      config: loadConfig(),
      confirm: async () => true,
      sessionId: "stop-turn",
      provider: "local",
      onEvent: (event) => events.push(event.type),
      generate: async ({ tools, shouldStop }) => {
        await tools.write.execute!({ path: "subnet/index.html", contents: "nope" }, localOpts);
        toolCalls += 1;
        expect(shouldStop?.()).toBe(true);
        await tools.read.execute!({ path: "." }, localOpts);
        await tools.write.execute!({ path: "subnet/index.html", contents: "again" }, localOpts);
        toolCalls += 2;
        return { text: "", inputTokens: 0, outputTokens: 0, finishReason: "tool-calls", steps: 3 };
      },
    });
    expect(receipt.tools).toHaveLength(1);
    expect(receipt.tools[0]?.name).toBe("write");
    expect(receipt.tools[0]?.source).toBe("agreement");
    expect(receipt.tools[0]?.deniedReason).toContain("unconfirmed delivery agreement");
    expect(receipt.outcome).toBe("blocked");
    expect(receipt.text).not.toContain("(no text)");
    expect(receipt.text).toContain("Blocked");
    expect(jevTools).toBe(0);
    expect(toolCalls).toBe(3);
    expect(events).toContain("evaluating");
    expect(events).toContain("waiting_model");
    expect(events).toContain("outcome");
  });

  it("keeps Jev live when a live turn hits an agreement denial", () => {
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "test-key";
    try {
      const receipt = {
        turn: { source: "jev" },
        tools: [
          {
            name: "write",
            source: "agreement",
            deniedReason: "unconfirmed delivery agreement 'controlled-delivery' hash abcd",
            approved: false,
          },
        ],
      } as unknown as Receipt;
      expect(jevHealthFromReceipt(false, receipt)).toBe("live");
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });

  it("emits phases and elapsed time, and still cancels", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-subnet-slow-"));
    const terminal = new MemoryTerminal();
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true },
      {
        cwd,
        terminal,
        handleLine: async (_line, state, opts, _confirm, onEvent) => {
          onEvent?.({ type: "evaluating" });
          onEvent?.({ type: "waiting_model" });
          const started = Date.now();
          while (Date.now() - started < 5000) {
            if (opts.abortSignal?.aborted) throw new Error("cancelled");
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          return { output: "late", session: state.session };
        },
      },
    );
    apps.push(app);
    for (const ch of "go") app.feed(ch);
    app.feed("\r");
    await waitFor(app, "waiting for model");
    const mid = app.lines().join("\n");
    expect(mid).toMatch(/waiting for model\s+\d+s/);
    expect(mid).not.toContain("ready");
    app.feed("\x03");
    const text = await waitFor(app, "cancelled");
    expect(text).toContain("cancelled");
    expect(text).not.toContain("late");
  });

  it("never returns (no text) for an empty model finish", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-subnet-empty-"));
    await writeAgreement(cwd, taskA());
    const receipt = await runLoop({
      plugins: shipped(),
      cwd,
      prompt: "are u building or?",
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => true,
      sessionId: "empty-turn",
      provider: "local",
      generate: async ({ tools }) => {
        await tools.write.execute!({ path: "x.txt", contents: "x" }, localOpts);
        return { text: "", inputTokens: 0, outputTokens: 0, finishReason: "length", steps: 8 };
      },
    });
    expect(receipt.text).not.toContain("(no text)");
    expect(receipt.text).toContain("Outcome  blocked");
    expect(receipt.finishReason).toBe("length");
    expect(receipt.steps).toBe(8);
    expect(
      formatTurnHandoff({
        modelText: "(no text)",
        outcome: "incomplete",
        tools: [],
        finishReason: "length",
        steps: 12,
        changed: [],
        checks: [],
        next: "Ask again.",
      }),
    ).not.toContain("(no text)");
  });

  it("does not let yes confirm a pending proposal after /new, /clear, an unrelated turn, or restart", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-subnet-session-"));
    await writeAgreement(cwd, taskA());
    const opts = { mockJev: true, yes: true, local: true } as const;
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("/task new subnet-probe", state, opts);
    const proposed = await handleLine(
      "UNIQUE_SUBNET_PROBE_REQUIREMENT: 192.168.1.10/24 must show 254 usable hosts.",
      state,
      opts,
    );
    expect(proposed.output).toContain("UNIQUE_SUBNET_PROBE_REQUIREMENT");
    const hash = proposed.output.match(/hash ([a-f0-9]+)/)?.[1];
    expect(hash).toBeTruthy();

    await handleLine("/new", state, opts);
    const afterNew = await handleLine("yes", state, opts);
    expect(afterNew.output).not.toMatch(/owner accepted|status: "confirmed"/);
    expect(afterNew.output).toContain("Plain yes did not confirm");
    expect((await loadTask(cwd))?.agreement.id).toBe("controlled-delivery");
    expect((await loadTask(cwd))?.agreement.status).toBe("proposed");

    await handleLine("/task new subnet-clear", state, opts);
    await handleLine("UNIQUE_CLEAR_REQUIREMENT for /30 usable hosts 2.", state, opts);
    await handleLine("/clear", state, opts);
    const afterClear = await handleLine("yes", state, opts);
    expect(afterClear.output).toContain("Plain yes did not confirm");

    await handleLine("/task new subnet-interrupt", state, opts);
    await handleLine("UNIQUE_INTERRUPT_REQUIREMENT broadcast 10.0.0.7.", state, opts);
    await handleLine("are you building or?", state, opts);
    const afterTalk = await handleLine("yes", state, opts);
    expect(afterTalk.output).toContain("Plain yes did not confirm");
    expect((await loadTask(cwd))?.agreement.id).toBe("controlled-delivery");

    await handleLine("/task new subnet-restart", state, opts);
    const restartProposal = await handleLine(
      "UNIQUE_RESTART_REQUIREMENT reject /31 prefixes.",
      state,
      opts,
    );
    const restartHash = restartProposal.output.match(/hash ([a-f0-9]+)/)?.[1];
    const restarted = await startState(cwd, { local: true, mockJev: true });
    const afterRestart = await handleLine("yes", restarted, opts);
    expect(afterRestart.output).toContain("Plain yes did not confirm");
    const explicit = await handleLine(`/task confirm subnet-restart ${restartHash}`, restarted, opts);
    expect(explicit.output).toContain("subnet-restart");
    expect(explicit.output).toContain("confirmed");
    expect((await loadTask(cwd))?.agreement.id).toBe("subnet-restart");
    const original = JSON.parse(
      await readFile(path.join(cwd, ".harness", "task", "agreement.json"), "utf8"),
    ) as { id: string; status: string };
    expect(original.id).toBe("controlled-delivery");
    expect(original.status).toBe("proposed");
  });

  it("labels step-cap tool-call stops incomplete even with planning text", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-subnet-cap-"));
    const config = { ...loadConfig(), maxSteps: 8 };
    expect(
      classifyTurnOutcome({
        finishReason: "tool-calls",
        steps: 8,
        maxSteps: 8,
        text: "I will now create the calculator",
        finalStepComplete: false,
      }),
    ).toBe("incomplete");
    const receipt = await runLoop({
      plugins: shipped(),
      cwd,
      prompt: "build it",
      jev: mockJev(),
      config,
      confirm: async () => true,
      sessionId: "cap-turn",
      provider: "local",
      generate: async () => ({
        text: "I will now create the calculator",
        inputTokens: 1,
        outputTokens: 8,
        finishReason: "tool-calls",
        steps: 8,
        finalStepComplete: false,
      }),
    });
    expect(receipt.outcome).toBe("incomplete");
    expect(receipt.text).toContain("Outcome  incomplete");
    expect(receipt.text).toContain("- (none this turn)");
    expect(receipt.finishReason).toBe("tool-calls");
    expect(receipt.steps).toBe(8);
  });

  it("shows the proposed subnet agreement for yes and supplies the full spec to the next build turn", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-subnet-review-"));
    await writeAgreement(cwd, taskA());
    const opts = { mockJev: true, yes: true, local: true } as const;
    const state = await startState(cwd, { local: true, mockJev: true });
    const spec = [
      "Build a tiny browser-based subnet calculator for networking students.",
      "UNIQUE_NEW_ACCEPTANCE: 192.168.1.10/24 → network 192.168.1.0, broadcast 192.168.1.255, usable hosts 254.",
      "Also 10.0.0.5/30 → network 10.0.0.4, broadcast 10.0.0.7, usable hosts 2.",
    ].join("\n");
    await handleLine("/task new subnet-calculator", state, opts);
    const drafted = await handleLine(spec, state, opts);
    expect(drafted.output).toContain("UNIQUE_NEW_ACCEPTANCE");
    expect(drafted.output).toContain("usable hosts 254");
    expect(drafted.output).not.toContain("Keep the existing engine.");
    expect(drafted.output).toContain("Preserved active task");
    expect(drafted.output).toContain("this is not what yes confirms");
    const history = await loadMessages(cwd, state.session.id);
    expect(history.some((row) => messageText(row).includes("UNIQUE_NEW_ACCEPTANCE"))).toBe(true);
    await handleLine("yes", state, opts);
    const system = await formatTaskSystemPrompt(cwd);
    expect(system).toContain("UNIQUE_NEW_ACCEPTANCE");
    expect(system).toContain("usable hosts 254");
    expect(system).toContain("10.0.0.5/30");
    expect(system).toContain(spec.split("\n")[0]!);
    let captured = "";
    const receipt = await runLoop({
      plugins: shipped(),
      cwd,
      prompt: "build it",
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => true,
      sessionId: "build-turn",
      provider: "local",
      system,
      generate: async ({ system: sys }) => {
        captured = sys ?? "";
        return { text: "ready to edit", inputTokens: 1, outputTokens: 1, finishReason: "stop", steps: 1, finalStepComplete: true };
      },
    });
    expect(captured).toContain("UNIQUE_NEW_ACCEPTANCE");
    expect(captured).toContain("usable hosts 254");
    expect(receipt.outcome).toBe("completed");
  });
});
