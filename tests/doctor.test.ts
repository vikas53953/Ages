import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctor, runDoctor } from "../src/doctor.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("aegis doctor", () => {
  it("says what is missing and how to fix it", async () => {
    process.env.AEGIS_HOME = await mkdtemp(path.join(os.tmpdir(), "aegis-doc-home-"));
    delete process.env.OPENCODE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-doc-"));
    const checks = await runDoctor(cwd, { network: false });
    const byItem = Object.fromEntries(checks.map((check) => [check.item, check]));
    expect(byItem["Node.js"]?.status).toBe("ok");
    expect(byItem["Chat model"]).toMatchObject({ status: "warn" });
    expect(byItem["Chat model"]?.fix).toContain("/login chatgpt");
    expect(byItem["Rules"]?.detail).toContain("defaults");
    expect(formatDoctor(checks)).toMatch(/Ready, with \d+ warning/);
  });

  it("an unreadable settings file is a failure with the fix", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-doc-bad-"));
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), "{ broken");
    const checks = await runDoctor(cwd, { network: false });
    expect(checks.find((check) => check.item === "Settings")).toMatchObject({ status: "fail" });
    expect(formatDoctor(checks)).toContain("problem(s) to fix");
  });

  it("/doctor works inside Aegis", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-doc-cmd-"));
    const state = await startState(cwd, { local: true, mockJev: true });
    const out = (await handleLine("/doctor", state, { mockJev: true, yes: false, local: true })).output;
    expect(out).toContain("Node.js");
  });
});
