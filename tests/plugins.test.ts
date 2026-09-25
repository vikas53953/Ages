import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlugins, KNOWN_PLUGINS } from "../src/plugins/index.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { settingsPath } from "../src/rules.ts";
import { writeAgreement } from "../src/plugins/delivery/delivery.ts";
import type { GenerateFn } from "../src/loop.ts";

const localOpts = { toolCallId: "t1", messages: [], context: {} } as never;

async function folder(plugins?: string[]) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-plugins-"));
  if (plugins) {
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ plugins }));
  }
  return cwd;
}

/** A model that writes one file, then answers. */
const writer: GenerateFn = async ({ tools }) => {
  const out = await tools.write.execute!({ path: "made.txt", contents: "x" }, localOpts);
  return { text: `result: ${String(out)}`, inputTokens: 0, outputTokens: 0, finishReason: "stop", steps: 1, finalStepComplete: true };
};

describe("plugin layer", () => {
  it("ships jev, delivery and receipts, loaded by name in order", () => {
    expect(KNOWN_PLUGINS).toEqual(["jev", "delivery", "receipts"]);
    const { plugins, unknown } = loadPlugins(["receipts", "nope", "jev"], { mockJev: true });
    expect(plugins.map((p) => p.name)).toEqual(["receipts", "jev"]);
    expect(unknown).toEqual(["nope"]);
  });

  it("the core runs a turn with no plugins at all", async () => {
    const cwd = await folder([]);
    // A proposed agreement would block writes, but only through the delivery plugin.
    await writeAgreement(cwd, {
      id: "t",
      status: "proposed",
      objective: "o",
      scope: ["s"],
      acceptance: [{ id: "c1", text: "a" }],
      exclusions: [],
    } as never);
    const state = await startState(cwd, { local: true, mockJev: true });
    expect(state.plugins).toEqual([]);
    expect(state.jevHealth).toBe("off");
    const asked: string[] = [];
    const result = await handleLine("make a file", state, { mockJev: true, yes: false, local: true, generate: writer }, async (q) => {
      asked.push(q);
      return true;
    });
    expect(asked).toHaveLength(1); // no rule and no scorer: you are asked
    expect(asked[0]).toContain("Jev off");
    expect(existsSync(path.join(cwd, "made.txt"))).toBe(true);
    expect(result.output).toContain("Ask a follow-up");
    expect(existsSync(path.join(cwd, ".harness", "receipts"))).toBe(false);
    expect((await handleLine("/task", state, { mockJev: true, yes: false, local: true })).output).toContain(
      "unknown command /task",
    );
    expect((await handleLine("/jev", state, { mockJev: true, yes: false, local: true })).output).toContain(
      "unknown command /jev",
    );
  });

  it("with the shipped plugins, delivery blocks the same write and receipts are saved", async () => {
    const cwd = await folder();
    await writeAgreement(cwd, {
      id: "t",
      status: "proposed",
      objective: "o",
      scope: ["s"],
      acceptance: [{ id: "c1", text: "a" }],
      exclusions: [],
    } as never);
    const state = await startState(cwd, { local: true, mockJev: true });
    expect(state.plugins.map((p) => p.name)).toEqual(["jev", "delivery", "receipts"]);
    const result = await handleLine("make a file", state, { mockJev: true, yes: true, local: true, generate: writer });
    expect(result.output).toContain("unconfirmed delivery agreement");
    expect(existsSync(path.join(cwd, "made.txt"))).toBe(false);
    expect((await readdir(path.join(cwd, ".harness", "receipts"))).length).toBe(1);
  });

  it("/help and /status list what the plugins add", async () => {
    const cwd = await folder(["jev", "delivery", "receipts", "mystery"]);
    const state = await startState(cwd, { local: true, mockJev: true });
    const help = (await handleLine("/help", state, { mockJev: true, yes: false, local: true })).output;
    expect(help).toContain("Plugins:");
    expect(help).toContain("/task confirm");
    expect(help).toContain("/jev off|second|every");
    const status = (await handleLine("/status", state, { mockJev: true, yes: false, local: true })).output;
    expect(status).toContain("plugins   jev, delivery, receipts  unknown: mystery");
    const turn = await handleLine("hi", state, {
      mockJev: true,
      yes: false,
      local: true,
      generate: async () => ({ text: "ok", inputTokens: 0, outputTokens: 0 }),
    });
    expect(turn.notice).toContain("Unknown plugins in settings: mystery");
  });

  it("an unknown slash command is reported instead of being sent to the model", async () => {
    const cwd = await folder();
    const state = await startState(cwd, { local: true, mockJev: true });
    let called = false;
    const out = await handleLine("/frobnicate now", state, {
      mockJev: true,
      yes: false,
      local: true,
      generate: async () => {
        called = true;
        return { text: "", inputTokens: 0, outputTokens: 0 };
      },
    });
    expect(out.output).toBe("unknown command /frobnicate. /help lists commands.");
    expect(called).toBe(false);
  });
});
