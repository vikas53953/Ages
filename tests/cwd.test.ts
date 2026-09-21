import { mkdtemp, readFile, symlink, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertInsideCwd } from "../src/env.ts";
import { runShell } from "../src/tools/shell.ts";
import { writePath } from "../src/tools/write.ts";

describe("cwd confinement", () => {
  it("rejects parent paths", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-cwd-"));
    await expect(assertInsideCwd("..", cwd)).rejects.toThrow(/outside/);
    await expect(assertInsideCwd("../secret.txt", cwd)).rejects.toThrow(/outside/);
  });

  it("refuses shell until an override is set", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-shell-"));
    const previous = process.env.AEGIS_ALLOW_SHELL;
    delete process.env.AEGIS_ALLOW_SHELL;
    try {
      await expect(runShell("Get-ChildItem", cwd)).rejects.toThrow(/disabled/);
    } finally {
      if (previous !== undefined) process.env.AEGIS_ALLOW_SHELL = previous;
    }
  });

  it("does not write through a file link to the outside", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "aegis-out-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-in-"));
    const secret = path.join(outside, "secret.txt");
    await writeFile(secret, "outside", "utf8");
    try {
      await symlink(secret, path.join(cwd, "note.txt"), "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOTSUP") return;
      throw error;
    }
    await writePath("note.txt", "inside", cwd);
    expect(await readFile(secret, "utf8")).toBe("outside");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("inside");
    expect((await lstat(path.join(cwd, "note.txt"))).isSymbolicLink()).toBe(false);
  });

  it("refuses a nested path through a junction parent before creating files", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "aegis-jout2-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-jin2-"));
    try {
      await symlink(outside, path.join(cwd, "escape"), "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOTSUP") return;
      throw error;
    }
    await expect(writePath("escape/nested/hack.txt", "no", cwd)).rejects.toThrow(/outside/);
    await expect(readFile(path.join(outside, "nested", "hack.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(outside, "nested"), "utf8")).rejects.toThrow();
  });
});
