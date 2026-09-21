import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addMemory, loadMemory } from "../src/memory.ts";
import {
  appendMessage,
  createSession,
  listSessions,
  loadMessages,
  loadOrCreateSession,
  switchSession,
} from "../src/session.ts";
import { formatSkills, loadSkills } from "../src/skills.ts";
import { mkdir, writeFile } from "node:fs/promises";

describe("session and memory", () => {
  it("creates a session, keeps messages, and resumes", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-sess-"));
    const first = await createSession(cwd, "s1");
    await appendMessage(cwd, first.id, {
      role: "user",
      content: "hello",
      at: "2026-09-20T00:00:00Z",
    });
    await appendMessage(cwd, first.id, {
      role: "assistant",
      content: "hi",
      at: "2026-09-20T00:00:01Z",
    });
    const second = await createSession(cwd, "s2");
    expect((await listSessions(cwd)).sort()).toEqual(["s1", "s2"]);
    expect((await loadOrCreateSession(cwd)).id).toBe(second.id);
    await switchSession(cwd, "s1");
    expect((await loadOrCreateSession(cwd)).id).toBe("s1");
    const messages = await loadMessages(cwd, "s1");
    expect(messages.map((m) => m.content)).toEqual(["hello", "hi"]);
  });

  it("stores memory notes", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-mem-"));
    await addMemory(cwd, "prefer short answers");
    expect(await loadMemory(cwd)).toContain("prefer short answers");
  });

  it("loads markdown skills", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-sk-"));
    await mkdir(path.join(cwd, "skills"), { recursive: true });
    await writeFile(path.join(cwd, "skills", "house.md"), "Stay in cwd.", "utf8");
    const skills = await loadSkills(cwd);
    expect(skills[0]?.name).toBe("house");
    expect(formatSkills(skills)).toContain("Stay in cwd.");
  });
});
