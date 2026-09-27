import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { switchSession } from "../src/session.ts";
import { findOnPath, system32, windowsPowerShell } from "../src/which.ts";

async function fakeProgram(dir: string, name: string) {
  const file = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
  await writeFile(file, "");
  await chmod(file, 0o755);
  return file;
}

describe("programs are found on PATH, never in the project folder", () => {
  it("skips relative PATH entries (a repo's own git.exe is not picked up) and returns a full path", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "aegis-which-project-"));
    const real = await mkdtemp(path.join(os.tmpdir(), "aegis-which-bin-"));
    await fakeProgram(project, "git");
    const expected = await fakeProgram(real, "git");
    // A relative entry that points at the project (only possible on the same drive), and ".".
    const relative = path.relative(process.cwd(), project);
    const entries = [...(path.isAbsolute(relative) ? [] : [relative]), ".", real];
    const env = { PATH: entries.join(path.delimiter), PATHEXT: ".EXE;.CMD" };
    expect(findOnPath("git", env)).toBe(expected);
    expect(findOnPath("no-such-program-aegis", env)).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("Windows tools come from System32 by full path", () => {
    expect(path.isAbsolute(system32("taskkill.exe"))).toBe(true);
    expect(windowsPowerShell()).toMatch(/WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  });
});

describe("session ids", () => {
  it("/resume refuses a path instead of an id", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-sid-"));
    await expect(switchSession(cwd, "../../x")).rejects.toThrow("not a session id");
    await expect(switchSession(cwd, "a/b")).rejects.toThrow("not a session id");
  });
});

describe("which: review fixes", () => {
  it("never falls back to a bare name, and reads quoted PATH entries", async () => {
    const { programPath } = await import("../src/which.ts");
    expect(() => programPath("aegis-no-such-program")).toThrow("not found on PATH");
    const real = await mkdtemp(path.join(os.tmpdir(), "aegis-which-quoted-"));
    const expected = await fakeProgram(real, "tool");
    expect(findOnPath("tool", { PATH: `"${real}"`, PATHEXT: ".EXE" })).toBe(expected);
  });
});
