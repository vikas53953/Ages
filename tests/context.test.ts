import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadContext } from "../src/context.ts";
import { buildSystemPrompt } from "../src/system.ts";

describe("loadContext", () => {
  it("loads AGENTS.md into the system prompt", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-ctx-"));
    await writeFile(path.join(cwd, "AGENTS.md"), "Prefer edit over write.", "utf8");
    const context = await loadContext(cwd);
    expect(context).toContain("Prefer edit over write.");
    const prompt = buildSystemPrompt({
      cwd,
      memory: "",
      skills: [],
      context,
    });
    expect(prompt).toContain("Prefer edit over write.");
  });
});
