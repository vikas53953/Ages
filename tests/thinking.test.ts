import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { formatTokenLine, formatTokens } from "../src/receipt.ts";
import { handleLine, modelChoices, startState } from "../src/runtime.ts";
import { settingsPath } from "../src/rules.ts";
import { loadMessages } from "../src/session.ts";
import { reasoningOptions } from "../src/thinking.ts";
import { createTuiApp } from "../src/tui-app.ts";
import { MemoryTerminal } from "../src/tui-memory.ts";
import { filterItems, ModelPicker } from "../src/tui-model-picker.ts";
import type { TurnEvent } from "../src/types.ts";

const usage = (output: number, reasoning: number) => ({
  inputTokens: { total: 1200, noCache: 1200, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output - reasoning, reasoning },
});

function thinkingModel(seen: Array<{ reasoning?: unknown; providerOptions?: unknown }>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      seen.push({ reasoning: (options as { reasoning?: unknown }).reasoning, providerOptions: options.providerOptions });
      call += 1;
      const chunks =
        call === 1
          ? [
              { type: "stream-start" as const, warnings: [] },
              { type: "reasoning-start" as const, id: "r" },
              { type: "reasoning-delta" as const, id: "r", delta: "The file is README.md, " },
              { type: "reasoning-delta" as const, id: "r", delta: "read it first." },
              { type: "reasoning-end" as const, id: "r" },
              { type: "tool-call" as const, toolCallId: "c1", toolName: "read", input: JSON.stringify({ path: "README.md" }) },
              { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage: usage(40, 30) },
            ]
          : [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: "It says hello." },
              { type: "text-end" as const, id: "t" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: usage(10, 0) },
            ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
}

describe("reasoning options per provider", () => {
  it("uses the SDK's own setting plus what OpenAI-style adapters read", () => {
    expect(reasoningOptions("medium", "chat")).toEqual({
      reasoning: "medium",
      providerOptions: {
        openai: { reasoningEffort: "medium", reasoningSummary: "auto" },
        opencode: { reasoningEffort: "medium" },
      },
    });
    expect(reasoningOptions("high", "responses").providerOptions).toEqual({
      openai: { reasoningEffort: "high", reasoningSummary: "auto" },
    });
    expect(reasoningOptions("low", "messages")).toEqual({ reasoning: "low", providerOptions: {} });
    expect(reasoningOptions("low", "gemini").providerOptions).toEqual({ google: { thinkingConfig: { includeThoughts: true } } });
    expect(reasoningOptions("off", "chat")).toEqual({ reasoning: "none", providerOptions: {} });
  });
});

describe("thinking in a turn", () => {
  it("streams reasoning as events, sends the level, keeps reasoning out of history, and totals tokens", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-think-"));
    await writeFile(path.join(cwd, "README.md"), "hello", "utf8");
    const seen: Array<{ reasoning?: unknown; providerOptions?: unknown }> = [];
    const events: TurnEvent[] = [];
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("/think high", state, { mockJev: true, yes: false, local: true });
    const out = await handleLine(
      "what does the readme say?",
      state,
      { mockJev: true, yes: false, local: true, generate: generateWith(thinkingModel(seen)) },
      async () => false,
      (event) => events.push(event),
    );
    expect(seen[0]?.reasoning).toBe("high");
    const thought = events.filter((e) => e.type === "reasoning_delta").map((e) => (e as { text: string }).text).join("");
    expect(thought).toBe("The file is README.md, read it first.");
    expect(out.receipt?.tokens).toEqual({ input: 2400, output: 50, reasoning: 30 });
    expect(out.output).toContain("tokens  ↑ 2.4k ↓ 50 · 30 thinking");
    expect(state.sessionTokens).toEqual({ input: 2400, output: 50 });
    const saved = JSON.stringify(await loadMessages(cwd, state.session.id));
    expect(saved).toContain("It says hello.");
    expect(saved).not.toContain("read it first");
  });
});

describe("/think", () => {
  it("saves the level and the display per project, and rejects nonsense", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-think-cmd-"));
    const state = await startState(cwd, { local: true, mockJev: true });
    const opts = { mockJev: true, yes: false, local: true };
    expect((await handleLine("/think", state, opts)).output).toContain("thinking  low");
    expect((await handleLine("/think medium", state, opts)).output).toBe("thinking medium");
    expect((await handleLine("/think show", state, opts)).output).toBe("reasoning shown live");
    const saved = JSON.parse(await readFile(settingsPath(cwd), "utf8"));
    expect(saved.thinking).toEqual({ level: "medium", display: "show" });
    expect((await handleLine("/think loud", state, opts)).output).toContain("usage: /think");
    expect((await handleLine("/status", state, opts)).output).toContain("thinking  medium · show");
  });
});

describe("tokens", () => {
  it("formats like Pi's footer", () => {
    expect(formatTokens(830)).toBe("830");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokenLine({ input: 12_400, output: 830 })).toBe("↑ 12k ↓ 830");
    expect(formatTokenLine({ input: 0, output: 0 })).toBe("");
  });
});

describe("/model picker", () => {
  it("lists auto first, then the default GLM models, then the catalogue", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-picker-"));
    const state = await startState(cwd, { local: true, mockJev: true });
    const choices = modelChoices(state);
    expect(choices[0]).toMatchObject({ id: "auto", group: "Aegis" });
    expect(choices.slice(1, 3).every((c) => c.group === "Defaults")).toBe(true);
    expect(filterItems(choices, "flash").every((c) => /flash/i.test(`${c.id} ${c.note}`))).toBe(true);
    expect(filterItems(choices, "glm-5.3-flash")[0]?.id).toBe("glm-5.3-flash");
  });

  it("filters by typing, moves with arrows, picks with enter, closes with esc", () => {
    const picked: Array<string | undefined> = [];
    const items = [
      { id: "auto", group: "Aegis", note: "Jev picks" },
      { id: "glm-5.3", group: "Defaults", note: "GLM 5.3" },
      { id: "glm-5.3-flash", group: "Defaults", note: "GLM 5.3 Flash" },
      { id: "kimi-k2.7-code", group: "Moonshot", note: "Kimi" },
    ];
    const picker = new ModelPicker(items, "auto", (id) => picked.push(id));
    for (const ch of "kimi") picker.handleInput(ch);
    expect(picker.render(60).join("\n")).toContain("kimi-k2.7-code");
    expect(picker.render(60).join("\n")).not.toContain("glm-5.3-flash");
    picker.handleInput("\r");
    const second = new ModelPicker(items, "auto", (id) => picked.push(id));
    second.handleInput("\x1b[B");
    second.handleInput("\r");
    const third = new ModelPicker(items, "auto", (id) => picked.push(id));
    third.handleInput("\x1b");
    expect(picked).toEqual(["kimi-k2.7-code", "glm-5.3", undefined]);
  });

  it("opens in the TUI on /model and pins the chosen model", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-picker-tui-"));
    const terminal = new MemoryTerminal();
    terminal.columns = 100;
    terminal.rows = 30;
    const app = await createTuiApp({ mockJev: true, yes: false, local: true }, { cwd, terminal });
    for (const ch of "/model") app.feed(ch);
    app.feed("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(terminal.writes.join("")).toContain("Pick a model");
    for (const ch of "glm-5.3-flash") app.feed(ch);
    app.feed("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(app.messages().join("\n")).toContain("model  glm-5.3-flash (pinned)");
    app.shutdown();
  });
});

describe("reasoning in the TUI", () => {
  it("folds to one line and ctrl+t opens it, saving the choice", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-fold-"));
    await writeFile(path.join(cwd, "README.md"), "hello", "utf8");
    const terminal = new MemoryTerminal();
    terminal.columns = 100;
    terminal.rows = 40;
    const app = await createTuiApp(
      { mockJev: true, yes: false, local: true, generate: generateWith(thinkingModel([])) },
      { cwd, terminal },
    );
    for (const ch of "what does the readme say?") app.feed(ch);
    app.feed("\r");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const folded = terminal.writes.join("");
    expect(folded).toContain("Thought for");
    expect(folded).not.toContain("read it first.");
    terminal.writes.length = 0;
    app.feed("\x14"); // ctrl+t
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(terminal.writes.join("")).toContain("read it first.");
    expect(JSON.parse(await readFile(settingsPath(cwd), "utf8")).thinking.display).toBe("show");
    app.shutdown();
  });
});
