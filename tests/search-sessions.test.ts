import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLine } from "../src/commands.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { appendMessage, createSession } from "../src/session.ts";

describe("/search", () => {
  it("finds conversations by what was said, and /resume <n> opens the hit", async () => {
    expect(parseLine("/search firewall")).toEqual({ type: "search", query: "firewall" });
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-search-"));
    const a = await createSession(cwd);
    await appendMessage(cwd, a.id, { role: "user", content: "fix the ping script", at: "2026-09-20T10:00:00.000Z" });
    await appendMessage(cwd, a.id, { role: "assistant", content: "Done. The FortiGate firewall rule is now in rules.ps1.", at: "2026-09-20T10:01:00.000Z" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await createSession(cwd);
    await appendMessage(cwd, b.id, { role: "user", content: "write a readme", at: "2026-09-21T10:00:00.000Z" });
    const state = await startState(cwd, { local: true, mockJev: true });
    const run = async (line: string) => (await handleLine(line, state, { mockJev: true, yes: false, local: true })).output ?? "";
    const out = await run("/search FIREWALL");
    expect(out).toContain("1.");
    expect(out).toContain("fix the ping script");
    expect(out).toContain("FortiGate firewall rule");
    expect(out).not.toContain("write a readme");
    expect(await run("/resume 1")).toContain(`resumed ${a.id}`);
    expect(await run("/search nothing-like-this")).toContain("No conversation here mentions");
  });
});
