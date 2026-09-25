import { mkdir, mkdtemp, readFile, symlink, writeFile, lstat } from "node:fs/promises";
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

  it("refuses a junction alias into .harness after resolve", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-jharness-"));
    const harness = path.join(cwd, ".harness");
    await mkdir(harness, { recursive: true });
    await writeFile(path.join(harness, "review-only.json"), '{"ownerAccepted":false}', "utf8");
    try {
      await symlink(harness, path.join(cwd, "record-alias"), "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "ENOTSUP") return;
      throw error;
    }
    await expect(writePath("record-alias/review-only.json", '{"ownerAccepted":true}', cwd)).rejects.toThrow(
      /Delivery records/,
    );
    expect(await readFile(path.join(harness, "review-only.json"), "utf8")).toBe('{"ownerAccepted":false}');
  });

  it("still denies a direct .harness write and still writes the inventory app", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-appwrite-"));
    await mkdir(path.join(cwd, "work", "device-inventory"), { recursive: true });
    await expect(writePath(".harness/review-only.json", '{"ownerAccepted":true}', cwd)).rejects.toThrow(
      /Delivery records/,
    );
    await writePath("work/device-inventory/server.mjs", "export {}\n", cwd);
    expect(await readFile(path.join(cwd, "work", "device-inventory", "server.mjs"), "utf8")).toContain("export");
  });

  it("refuses the checker script from the project cwd and from the builder work dir", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-checker-"));
    const work = path.join(cwd, "work", "device-inventory");
    await mkdir(path.join(cwd, "scripts"), { recursive: true });
    await mkdir(work, { recursive: true });
    await expect(writePath("scripts/check-device-inventory.mjs", "stolen", cwd)).rejects.toThrow(/Checker script/);
    await expect(writePath("../scripts/check-device-inventory.mjs", "stolen", work)).rejects.toThrow(/outside/);
    await writePath("server.mjs", "ok\n", work);
    expect(await readFile(path.join(work, "server.mjs"), "utf8")).toBe("ok\n");
  });
});
