import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleLine, startState } from "../src/runtime.ts";

const saved = { home: process.env.AEGIS_HOME, key: process.env.OPENCODE_API_KEY };

afterEach(() => {
  if (saved.home === undefined) delete process.env.AEGIS_HOME;
  else process.env.AEGIS_HOME = saved.home;
  if (saved.key === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = saved.key;
});

describe("/login and /logout", () => {
  it("saves a key to ~/.aegis/.env once, masked in the reply, and removes it again", async () => {
    process.env.AEGIS_HOME = await mkdtemp(path.join(os.tmpdir(), "aegis-home-"));
    delete process.env.OPENCODE_API_KEY;
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-login-"));
    const state = await startState(cwd, { local: true, mockJev: true });
    const opts = { mockJev: true, yes: false, local: true };

    const status = (await handleLine("/login", state, opts)).output;
    expect(status).toMatch(/opencode\s+not set/);

    const saved = (await handleLine("/login opencode sk-test-abcd1234", state, opts)).output;
    expect(saved).toContain("••••1234");
    expect(saved).not.toContain("sk-test-abcd1234");
    const file = path.join(process.env.AEGIS_HOME, ".env");
    expect(await readFile(file, "utf8")).toBe("OPENCODE_API_KEY=sk-test-abcd1234\n");
    expect(process.env.OPENCODE_API_KEY).toBe("sk-test-abcd1234");

    await handleLine("/login opencode sk-second-9999", state, opts);
    expect(await readFile(file, "utf8")).toBe("OPENCODE_API_KEY=sk-second-9999\n");

    await handleLine("/logout opencode", state, opts);
    expect(await readFile(file, "utf8")).toBe("");
    expect(process.env.OPENCODE_API_KEY).toBeUndefined();

    expect((await handleLine("/login nope x", state, opts)).output).toContain("unknown key name 'nope'");
  });
});
