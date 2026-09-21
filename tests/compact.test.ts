import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compactSession } from "../src/compact.ts";
import { appendMessage, createSession, loadMessages } from "../src/session.ts";

describe("compactSession", () => {
  it("folds old turns into a summary and keeps the last ones", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-compact-"));
    const session = await createSession(cwd, "c1");
    for (let i = 0; i < 6; i++) {
      await appendMessage(cwd, session.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
        at: `2026-09-20T00:00:0${i}Z`,
      });
    }
    const result = await compactSession(cwd, session.id, 2);
    expect(result.summarized).toBe(4);
    const messages = await loadMessages(cwd, session.id);
    expect(messages[0]?.content).toContain("[compacted 4 messages]");
    expect(messages.map((m) => m.content).slice(-2)).toEqual(["m4", "m5"]);
  });
});
