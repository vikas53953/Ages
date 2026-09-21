import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleLine, startState } from "../src/runtime.ts";

describe("runtime handleLine", () => {
  it("returns help and does not exit", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-rt-"));
    const state = await startState(cwd, { local: true });
    const result = await handleLine("/help", state, {
      mockJev: true,
      yes: true,
      local: true,
    });
    expect(result.exit).toBeUndefined();
    expect(result.output).toContain("/compact");
  });

  it("exits on /exit", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-rt2-"));
    const state = await startState(cwd, { local: true });
    const result = await handleLine("/exit", state, {
      mockJev: true,
      yes: true,
      local: true,
    });
    expect(result.exit).toBe(true);
  });

  it("lists models and pins one", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-rt3-"));
    const state = await startState(cwd, { local: true });
    const listed = await handleLine("/models", state, {
      mockJev: true,
      yes: true,
      local: true,
    });
    expect(listed.output).toContain("glm-5.3");
    expect(listed.output).toContain("gpt-5.5");
    expect(listed.output).toContain("claude-opus-5");
    expect(listed.output).toContain("kimi-k2.7-code");
    const switched = await handleLine("/model kimi-k2.7-code", state, {
      mockJev: true,
      yes: true,
      local: true,
    });
    expect(switched.output).toContain("kimi-k2.7-code");
    expect(state.model).toBe("kimi-k2.7-code");
    expect(state.modelMode).toBe("pinned");
    const auto = await handleLine("/model auto", state, {
      mockJev: true,
      yes: true,
      local: true,
    });
    expect(auto.output).toContain("auto");
    expect(state.modelMode).toBe("auto");
  });

  it("starts in auto so Jev can route spend", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-rt4-"));
    const state = await startState(cwd, { local: true });
    expect(state.modelMode).toBe("auto");
    expect(state.model).toBe("auto");
  });
});
