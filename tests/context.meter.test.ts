import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleLine, startState } from "../src/runtime.ts";
import { appendMessage, createSession } from "../src/session.ts";
import { footerText } from "../src/tui-layout.ts";

describe("context meter", () => {
  it("shows how close the conversation is to auto-compaction, in the footer and /status", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-ctx-"));
    await writeFile(path.join(cwd, "gate.config.json"), JSON.stringify({ compactAtChars: 1000 }));
    const session = await createSession(cwd);
    await appendMessage(cwd, session.id, { role: "user", content: "x".repeat(248), at: new Date().toISOString() });
    const state = await startState(cwd, { local: true, mockJev: true });
    expect(state.contextPercent).toBe(25); // 250 characters of 1000 ("x…" plus JSON quotes)
    expect((await handleLine("/status", state, { mockJev: true, yes: false, local: true })).output).toContain("context   25%");
    expect(footerText({ modelMode: "auto", model: "auto", jev: "off", provider: "local", context: 25 })).toContain("ctx 25%");
    await handleLine("/new", state, { mockJev: true, yes: false, local: true });
    expect(state.contextPercent).toBe(0);
  });
});
