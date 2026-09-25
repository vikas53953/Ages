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

  it("says where the duplicate matches are, and replace_all changes every one", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-edit4-"));
    await writeFile(path.join(cwd, "note.txt"), "a\nfoo\nb\nfoo\n", "utf8");
    await expect(editPath("note.txt", "foo", "bar", cwd)).rejects.toThrow(/at lines 2, 4/);
    expect(await editPath("note.txt", "foo", "bar", cwd, { replaceAll: true })).toBe("edited note.txt (2 places)");
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("a\nbar\nb\nbar\n");
  });

  it("edits a Windows (CRLF) file with the model's \\n text and keeps CRLF", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-edit5-"));
    await writeFile(path.join(cwd, "a.ps1"), "Write-Host 1\r\nWrite-Host 2\r\nWrite-Host 3\r\n", "utf8");
    await editPath("a.ps1", "Write-Host 1\nWrite-Host 2", "Write-Host one\nWrite-Host two", cwd);
    expect(await readFile(path.join(cwd, "a.ps1"), "utf8")).toBe("Write-Host one\r\nWrite-Host two\r\nWrite-Host 3\r\n");
  });
});

