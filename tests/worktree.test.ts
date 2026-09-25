import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.ts";
import { defaultWorktreeName, openWorktree } from "../src/worktree.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

async function repo() {
  const base = await mkdtemp(path.join(os.tmpdir(), "aegis-wt-"));
  const cwd = path.join(base, "app");
  execFileSync("git", ["init", "-q", "-b", "main", cwd]);
  await writeFile(path.join(cwd, "a.txt"), "one\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "first");
  return cwd;
}

describe("--worktree", () => {
  it("creates <repo>.worktrees/<name> on branch aegis/<name>, and reuses it next time", async () => {
    const cwd = await repo();
    const first = await openWorktree(cwd, "fix-login");
    expect(first.created).toBe(true);
    expect(first.branch).toBe("aegis/fix-login");
    expect(first.path.split(path.sep).slice(-2)).toEqual(["app.worktrees", "fix-login"]);
    expect(await readFile(path.join(first.path, "a.txt"), "utf8")).toBe("one\n");
    expect(git(first.path, "branch", "--show-current").trim()).toBe("aegis/fix-login");
    await writeFile(path.join(first.path, "a.txt"), "changed in the worktree\n");
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("one\n"); // your checkout is untouched
    const again = await openWorktree(cwd, "fix-login");
    expect(again).toMatchObject({ created: false, path: first.path });
  });

  it("refuses bad names and folders that are not repositories", async () => {
    const cwd = await repo();
    await expect(openWorktree(cwd, "../escape")).rejects.toThrow("not a usable worktree name");
    await expect(openWorktree(cwd, "-rf")).rejects.toThrow("not a usable worktree name");
    const plain = await mkdtemp(path.join(os.tmpdir(), "aegis-wt-plain-"));
    await expect(openWorktree(plain, "x")).rejects.toThrow("needs a git repository");
    expect(defaultWorktreeName(new Date(2026, 8, 25, 21, 5))).toBe("session-20260925-2105");
  });

  it("a repo's smudge filter and hooks do not run while the worktree is checked out", async () => {
    const cwd = await repo();
    const marker = path.join(cwd, "PWNED").replace(/\\/g, "/");
    const evil = path.join(cwd, "evil.sh");
    await writeFile(evil, `#!/bin/sh\necho pwned > "${marker}"\ncat\n`);
    await chmod(evil, 0o755);
    await writeFile(path.join(cwd, ".gitattributes"), "*.txt filter=evil\n");
    git(cwd, "add", ".gitattributes");
    git(cwd, "commit", "-q", "-m", "attrs");
    git(cwd, "config", "filter.evil.smudge", evil.replace(/\\/g, "/"));
    git(cwd, "config", "core.hooksPath", path.join(cwd, "hooks"));
    await openWorktree(cwd, "safe");
    expect(existsSync(path.join(cwd, "PWNED"))).toBe(false);
  });

  it("the flag: --worktree names one for you, --worktree=name uses yours", () => {
    expect(parseArgs(["--worktree=fix"]).worktree).toBe("fix");
    expect(parseArgs(["--worktree"]).worktree).toMatch(/^session-\d{8}-\d{4}$/);
    expect(parseArgs([]).worktree).toBeUndefined();
  });
});
