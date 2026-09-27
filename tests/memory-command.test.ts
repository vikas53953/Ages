import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadMemory } from "../src/memory.ts";
import { handleLine, startState } from "../src/runtime.ts";

describe("/memory", () => {
  it("numbers the notes and forgets one", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-memory-cmd-"));
    const state = await startState(cwd, { local: true, mockJev: true });
    const run = async (line: string) => (await handleLine(line, state, { mockJev: true, yes: false, local: true })).output ?? "";
    expect(await run("/memory")).toContain("(empty)");
    await run("/memory use PowerShell 7");
    await run("/memory the firewall lab is 10.0.0.0/24");
    const list = await run("/memory");
    expect(list).toMatch(/1 {2}- \d{4}-\d{2}-\d{2} use PowerShell 7/);
    expect(list).toMatch(/2 {2}- .* firewall lab/);
    expect(await run("/memory remove 1")).toContain("Forgot: - ");
    expect(await loadMemory(cwd)).not.toContain("PowerShell");
    expect(await loadMemory(cwd)).toContain("firewall lab");
    expect(await run("/memory remove 5")).toContain("usage");
  });
});
