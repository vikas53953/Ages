import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { editPath } from "../src/tools/edit.ts";

describe("editPath", () => {
  it("replaces a unique string", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-edit-"));
    await writeFile(path.join(cwd, "note.txt"), "hello world", "utf8");
    await editPath("note.txt", "world", "harness", cwd);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("hello harness");
  });

  it("refuses a non-unique string", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-edit2-"));
    await writeFile(path.join(cwd, "note.txt"), "aa aa", "utf8");
    await expect(editPath("note.txt", "aa", "bb", cwd)).rejects.toThrow(/not unique/);
  });

  it("keeps $& literal in the replacement", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-edit3-"));
    await writeFile(path.join(cwd, "note.txt"), "OLD", "utf8");
    await editPath("note.txt", "OLD", "x$&y", cwd);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("x$&y");
  });
});
