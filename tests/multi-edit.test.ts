import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { toAegisCall } from "../src/engines/claude-code.ts";
import { formatConfirm } from "../src/gated.ts";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { multiEditPath } from "../src/tools/edit.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
function scripted(steps: Array<{ tool: string; input: object } | { text: string }>) {
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

async function project(rules: object) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-multi-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules }));
  await writeFile(path.join(cwd, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  return cwd;
}

describe("multi_edit", () => {
  it("applies edits in order, each on the result of the one before", async () => {
    const cwd = await project({});
    const out = await multiEditPath("app.ts", [
      { old_string: "const a = 1;", new_string: "const a = 10;" },
      { old_string: "const a = 10;\nconst b", new_string: "const a = 10;\nlet b" },
      { old_string: "const", new_string: "let", replace_all: true },
    ], cwd);
    expect(out).toBe("edited app.ts (3 edits, 4 places)");
    expect(await readFile(path.join(cwd, "app.ts"), "utf8")).toBe("let a = 10;\nlet b = 2;\nlet c = 3;\n");
  });

  it("all or nothing: one bad edit leaves the file untouched and says which", async () => {
    const cwd = await project({});
    await expect(
      multiEditPath("app.ts", [
        { old_string: "const a = 1;", new_string: "const a = 10;" },
        { old_string: "missing", new_string: "x" },
      ], cwd),
    ).rejects.toThrow("edit 2: old_string not found");
    expect(await readFile(path.join(cwd, "app.ts"), "utf8")).toBe("const a = 1;\nconst b = 2;\nconst c = 3;\n");
  });

  it("passes the lock as edit: an edit rule allows it, the question shows every change", async () => {
    const cwd = await project({ allow: ["edit app.ts"] });
    const state = await startState(cwd, { local: true, mockJev: true });
    const result = await handleLine("rename", state, {
      mockJev: true, yes: false, local: true,
      generate: generateWith(scripted([
        { tool: "multi_edit", input: { path: "app.ts", edits: [{ old_string: "const a", new_string: "let a" }, { old_string: "const b", new_string: "let b" }] } },
        { text: "renamed" },
      ])),
    });
    expect(result.receipt?.tools[0]).toMatchObject({ name: "edit", approved: true, rule: "edit app.ts" });
    expect(await readFile(path.join(cwd, "app.ts"), "utf8")).toBe("let a = 1;\nlet b = 2;\nconst c = 3;\n");
    const question = formatConfirm("edit", { path: "app.ts", edits: JSON.stringify([{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }]) });
    expect(question).toContain("(2 edits, all or nothing)");
    expect(question).toContain("edit 2:");
    expect(question).toContain("  + q");
  });

  it("with no rule it asks, and No leaves the file alone", async () => {
    const cwd = await project({});
    const state = await startState(cwd, { local: true, mockJev: true });
    const asked: string[] = [];
    await handleLine("rename", state, {
      mockJev: true, yes: false, local: true,
      generate: generateWith(scripted([
        { tool: "multi_edit", input: { path: "app.ts", edits: [{ old_string: "const a", new_string: "let a" }] } },
        { text: "ok" },
      ])),
    }, async (question) => {
      asked.push(question);
      return false;
    });
    expect(asked[0]).toContain("- const a");
    expect(await readFile(path.join(cwd, "app.ts"), "utf8")).toContain("const a = 1;");
  });

  it("Claude Code's MultiEdit shows every change in the question", () => {
    const call = toAegisCall("MultiEdit", { file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] });
    expect(call.name).toBe("edit");
    expect(formatConfirm(call.name, call.args as never)).toContain("  + y");
  });
});
