import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { currentTodos, handleLine, startState } from "../src/runtime.ts";
import { cleanTodos, todoLines } from "../src/todos.ts";
import type { TurnEvent } from "../src/types.ts";
import { replaceMessages } from "../src/session.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type Step = { tool: string; input: object } | { text: string };
function scripted(steps: Step[]) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[index++] ?? { text: "done" };
      const chunks =
        "tool" in step
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: `c${index}`, toolName: step.tool, input: JSON.stringify(step.input) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: step.text },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
}

const list = {
  todos: [
    { content: "Read the config", status: "completed" },
    { content: "Add the ping script", status: "in_progress" },
    { content: "Test it", status: "pending" },
  ],
};

async function project(settings: object = { jev: { mode: "every-call" } }) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-todo-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify(settings));
  const state = await startState(cwd, { local: true, mockJev: true });
  return { cwd, state };
}

describe("todo tool", () => {
  it("runs without asking (even with Jev on every call), emits the list, and /todos shows it from the session", async () => {
    const { state } = await project();
    const events: TurnEvent[] = [];
    const result = await handleLine(
      "plan it",
      state,
      { mockJev: true, yes: false, local: true, generate: generateWith(scripted([{ tool: "todo", input: list }, { text: "ok" }])) },
      async () => {
        throw new Error("must not ask");
      },
      (event) => events.push(event),
    );
    expect(result.receipt?.tools[0]).toMatchObject({ name: "todo", approved: true, action: "auto" });
    const shown = events.find((event) => event.type === "todos");
    expect(shown && shown.type === "todos" ? shown.todos.length : 0).toBe(3);
    expect(await currentTodos(state)).toHaveLength(3);
    expect((await handleLine("/todos", state, { mockJev: true, yes: false, local: true })).output).toContain("[>] Add the ping script");
  });

  it("works in plan mode, and a deny rule still turns it off", async () => {
    const { state } = await project({ jev: { mode: "off" }, rules: { deny: ["todo"] } });
    const result = await handleLine(
      "plan it",
      state,
      { mockJev: true, yes: false, local: true, generate: generateWith(scripted([{ tool: "todo", input: list }, { text: "ok" }])) },
    );
    expect(result.receipt?.tools[0]).toMatchObject({ name: "todo", approved: false, rule: "todo" });

    const planned = await project({ jev: { mode: "off" } });
    await handleLine("/plan", planned.state, { mockJev: true, yes: false, local: true });
    const inPlan = await handleLine(
      "plan it",
      planned.state,
      { mockJev: true, yes: false, local: true, generate: generateWith(scripted([{ tool: "todo", input: list }, { text: "ok" }])) },
    );
    expect(inPlan.receipt?.tools[0]).toMatchObject({ name: "todo", approved: true });
  });

  it("cleans what the model sends: caps, control characters and escape codes, unknown statuses", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ content: `step ${i}`, status: "pending" }));
    expect(cleanTodos(many)).toHaveLength(30);
    const [row] = cleanTodos([{ content: "evil\u001b[2J\u0007 text" + "x".repeat(300), status: "weird" }]);
    expect(row!.content.startsWith("evil  text")).toBe(true);
    expect(row!.content).not.toMatch(/[\u0000-\u001f]/);
    expect(row!.content.length).toBe(200);
    expect(row!.status).toBe("pending");
  });

  it("the TUI box hides when all is done and shows open work first", () => {
    expect(todoLines([{ content: "a", status: "completed" }])).toEqual([]);
    const lines = todoLines(cleanTodos(list.todos));
    expect(lines).toEqual(["[x] Read the config", "[>] Add the ping script", "[ ] Test it"]);
  });
});

describe("todo list survives compaction", () => {
  it("is kept with the session, not only in the turns compaction drops", async () => {
    const { state } = await project({ jev: { mode: "off" } });
    await handleLine(
      "plan it",
      state,
      { mockJev: true, yes: false, local: true, generate: generateWith(scripted([{ tool: "todo", input: list }, { text: "ok" }])) },
    );
    await replaceMessages(state.cwd, state.session.id, []); // what compaction does to old turns
    expect(await currentTodos(state)).toHaveLength(3);
  });
});
