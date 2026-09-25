import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitBranch } from "../src/git-head.ts";
import { footerText } from "../src/tui-layout.ts";

describe("git branch in the footer", () => {
  it("reads .git/HEAD: a branch, from a subfolder, detached, none", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-head-"));
    expect(gitBranch(cwd)).toBeUndefined();
    await mkdir(path.join(cwd, ".git"));
    await writeFile(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/aegis/fix-login\n");
    await mkdir(path.join(cwd, "src", "deep"), { recursive: true });
    expect(gitBranch(path.join(cwd, "src", "deep"))).toBe("aegis/fix-login");
    await writeFile(path.join(cwd, ".git", "HEAD"), "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39\n");
    expect(gitBranch(cwd)).toBe("3f2a9c1");
  });

  it("a crafted HEAD cannot put escape codes into the terminal", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-head-evil-"));
    await mkdir(path.join(cwd, ".git"));
    await writeFile(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\x1b]0;pwned\x07\x1b[2J\n");
    const branch = gitBranch(cwd)!;
    expect(branch).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(branch.startsWith("main")).toBe(true);
  });

  it("a real worktree shows its own branch", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "aegis-head-wt-"));
    const repo = path.join(base, "app");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    await writeFile(path.join(repo, "a.txt"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "one");
    git(repo, "worktree", "add", "-q", "-b", "feature", path.join(base, "wt"));
    expect(gitBranch(repo)).toBe("main");
    expect(gitBranch(path.join(base, "wt"))).toBe("feature");
  }, 30_000);

  it("the footer shows it after the folder", () => {
    const text = footerText({ modelMode: "auto", model: "x", jev: "mock", provider: "local", cwd: "~/app", branch: "main" });
    expect(text.startsWith("~/app (main) · auto")).toBe(true);
  });
});

describe("git branch: review fixes", () => {
  it.skipIf(process.platform === "win32")("a named pipe called HEAD does not freeze Aegis", async () => {
    const { execFileSync } = await import("node:child_process");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-head-fifo-"));
    await mkdir(path.join(cwd, ".git"));
    execFileSync("mkfifo", [path.join(cwd, ".git", "HEAD")]);
    expect(gitBranch(cwd)).toBeUndefined();
  });

  it("a huge HEAD is not read", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-head-big-"));
    await mkdir(path.join(cwd, ".git"));
    await writeFile(path.join(cwd, ".git", "HEAD"), `ref: refs/heads/${"x".repeat(10_000)}`);
    expect(gitBranch(cwd)).toBeUndefined();
  });
});

describe("git branch: no blocking open", () => {
  it("still reads a normal HEAD after the non-blocking open", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-head-nb-"));
    await mkdir(path.join(cwd, ".git"));
    await writeFile(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/dev\n");
    expect(gitBranch(cwd)).toBe("dev");
  });
});
