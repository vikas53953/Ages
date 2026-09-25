import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeConfirm } from "../src/confirm-queue.ts";
import { formatConfirm, formatActionDiff, runGatedTool } from "../src/gated.ts";
import { failClosedTool, failClosedTurn } from "../src/plugins/jev/evaluate.ts";
import { mockTool } from "../src/plugins/jev/mock.ts";
import { decideToolAction } from "../src/policy.ts";
import { loadConfig } from "../src/config.ts";

async function tmp() {
  return mkdtemp(path.join(os.tmpdir(), "aegis-lock-"));
}

describe("Jev fail-closed lock", () => {
  it("does not treat File::Delete as read_only in mock", () => {
    const decision = mockTool({
      name: "shell",
      args: { command: '[System.IO.File]::Delete("example.txt")' },
      cwd: ".",
      git: false,
    });
    expect(decision.class).toBe("irreversible");
    expect(decideToolAction(decision, loadConfig())).toBe("confirm");
  });

  it("treats unrecognized shell as irreversible, not read_only", () => {
    const decision = mockTool({
      name: "shell",
      args: { command: "Invoke-WebRequest http://example" },
      cwd: ".",
      git: false,
    });
    expect(decision.class).toBe("irreversible");
    expect(decideToolAction(decision, loadConfig())).toBe("confirm");
  });

  it("puts the write payload on the confirm prompt", () => {
    const question = formatConfirm(
      "write",
      { path: "note.txt", contents: "secret-body" },
      mockTool({ name: "write", args: { path: "note.txt" }, cwd: ".", git: false }),
    );
    expect(question).toContain("note.txt");
    expect(question).toContain("secret-body");
    expect(question).toContain("[y/N]");
  });

  it("puts an edit diff on the confirm prompt", () => {
    const question = formatConfirm(
      "edit",
      { path: "note.txt", old_string: "alpha", new_string: "beta" },
      mockTool({ name: "edit", args: { path: "note.txt" }, cwd: ".", git: false }),
    );
    expect(question).toContain("note.txt");
    expect(question).toContain("--- old");
    expect(question).toContain("- alpha");
    expect(question).toContain("+ beta");
    expect(formatActionDiff("alpha", "beta")).toContain("- alpha");
  });

  it("does not clip a long write payload off the confirm prompt", () => {
    const contents = `keep-me-${"x".repeat(600)}-tail`;
    const question = formatConfirm(
      "write",
      { path: "note.txt", contents },
      mockTool({ name: "write", args: { path: "note.txt" }, cwd: ".", git: false }),
    );
    expect(question).toContain("keep-me-");
    expect(question).toContain("-tail");
  });

  it("does not execute after abort during Jev evaluation", async () => {
    const cwd = await tmp();
    const abort = new AbortController();
    let executed = false;
    const result = await runGatedTool({
      name: "write",
      args: { path: "x.txt", contents: "no" },
      cwd,
      jev: {
        evaluateTurn: async () => failClosedTurn(),
        evaluateTool: async () => {
          abort.abort();
          return mockTool({
            name: "write",
            args: { path: "x.txt", contents: "no" },
            cwd: ".",
            git: false,
          });
        },
      },
      config: loadConfig(),
      confirm: async () => true,
      abortSignal: abort.signal,
      execute: async () => {
        executed = true;
        return "wrote";
      },
    });
    expect(executed).toBe(false);
    expect(result.record.approved).toBe(false);
    expect(result.record.deniedReason).toBe("cancelled");
  });

  it("settles a hanging Jev evaluation on abort without executing", async () => {
    const cwd = await tmp();
    const abort = new AbortController();
    let executed = false;
    const pending = runGatedTool({
      name: "write",
      args: { path: "x.txt", contents: "no" },
      cwd,
      jev: {
        evaluateTurn: async () => failClosedTurn(),
        evaluateTool: () => new Promise(() => {}),
      },
      config: loadConfig(),
      confirm: async () => true,
      abortSignal: abort.signal,
      execute: async () => {
        executed = true;
        return "wrote";
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    const result = await pending;
    expect(executed).toBe(false);
    expect(result.record.deniedReason).toBe("cancelled");
  });

  it("does not execute after abort during a hanging confirm", async () => {
    const cwd = await tmp();
    const abort = new AbortController();
    let executed = false;
    const pending = runGatedTool({
      name: "write",
      args: { path: "x.txt", contents: "no" },
      cwd,
      jev: {
        evaluateTurn: async () => failClosedTurn(),
        evaluateTool: async () => ({
          class: "irreversible",
          dataLoss: 0.9,
          confidence: 0.9,
          probabilities: { class: { read_only: 0, reversible: 0, irreversible: 1 } },
          source: "mock",
        }),
      },
      config: loadConfig(),
      confirm: () => new Promise<boolean>(() => {}),
      abortSignal: abort.signal,
      execute: async () => {
        executed = true;
        return "wrote";
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    const result = await pending;
    expect(executed).toBe(false);
    expect(result.record.deniedReason).toBe("cancelled");
  });

  it("does not run a later tool after abort", async () => {
    const cwd = await tmp();
    const abort = new AbortController();
    let executed = 0;
    const irreversible = {
      class: "irreversible" as const,
      dataLoss: 0.9,
      confidence: 0.9,
      probabilities: { class: { read_only: 0, reversible: 0, irreversible: 1 } },
      source: "mock" as const,
    };
    const run = () =>
      runGatedTool({
        name: "write",
        args: { path: "x.txt", contents: "no" },
        cwd,
        jev: {
          evaluateTurn: async () => failClosedTurn(),
          evaluateTool: async () => {
            abort.abort();
            return irreversible;
          },
        },
        config: loadConfig(),
        confirm: async () => true,
        abortSignal: abort.signal,
        execute: async () => {
          executed += 1;
          return "wrote";
        },
      });
    const first = await run();
    const second = await run();
    expect(executed).toBe(0);
    expect(first.record.deniedReason).toBe("cancelled");
    expect(second.record.deniedReason).toBe("cancelled");
  });

  it("asks you (default n) instead of running when live Jev cannot score a write", async () => {
    expect(failClosedTurn().source).toBe("fail_closed");
    expect(decideToolAction(failClosedTool(), loadConfig())).toBe("confirm");
    const cwd = await tmp();
    const asked: string[] = [];
    const result = await runGatedTool({
      name: "write",
      args: { path: "x.txt", contents: "no" },
      cwd,
      jev: {
        evaluateTurn: async () => failClosedTurn(),
        evaluateTool: async () => failClosedTool(),
      },
      config: loadConfig(),
      confirm: async (question) => {
        asked.push(question);
        return false;
      },
      execute: async () => {
        throw new Error("must not run");
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Jev could not score");
    expect(result.record.approved).toBe(false);
    expect(result.record.action).toBe("confirm");
    expect(result.record.source).toBe("fail_closed");
    expect(result.record.deniedReason).toBe("user declined");
  });

  it("queues overlapping confirms so the first waiter is not dropped", async () => {
    const seen: string[] = [];
    const confirm = serializeConfirm(async (question) => {
      seen.push(question);
      return question.includes("one");
    });
    const [a, b] = await Promise.all([confirm("one?"), confirm("two?")]);
    expect(seen).toEqual(["one?", "two?"]);
    expect(a).toBe(true);
    expect(b).toBe(false);
  });
});
