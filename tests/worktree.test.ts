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

describe("--worktree: review fixes", () => {
  it("a worktree shares its project's trust and your saved rules", async () => {
    const { loadSettingsWithTrust, saveAllowRule, setProjectTrust, loadSettings, matchRule } = await import("../src/rules.ts");
    const saved = { ...process.env };
    delete process.env.AEGIS_TRUST_PROJECT;
    process.env.AEGIS_HOME = await mkdtemp(path.join(os.tmpdir(), "aegis-wt-home-"));
    try {
      const cwd = await repo();
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(cwd, ".aegis"));
      await writeFile(path.join(cwd, ".aegis", "settings.json"), JSON.stringify({ rules: { allow: ["shell npm test"] } }));
      git(cwd, "add", ".aegis");
      git(cwd, "commit", "-q", "-m", "settings");
      setProjectTrust(cwd, loadSettingsWithTrust(cwd).trust.hash);
      saveAllowRule(cwd, "write docs/*");
      const opened = await openWorktree(cwd, "shared");
      const inWorktree = loadSettingsWithTrust(opened.path);
      expect(inWorktree.trust.trusted).toBe(true);
      expect(matchRule(loadSettings(opened.path), "write", { path: "docs/a.md" }, opened.path)?.action).toBe("allow");
      expect(inWorktree.settings.rules.allow).toContain("shell npm test");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("started from inside a worktree, a new one goes next to the main checkout (no nesting)", async () => {
    const cwd = await repo();
    const a = await openWorktree(cwd, "a");
    const b = await openWorktree(a.path, "b");
    expect(path.dirname(b.path)).toBe(path.dirname(a.path));
  });

  it("refuses a folder that is not its worktree; recovers a worktree folder deleted by hand", async () => {
    const cwd = await repo();
    const { mkdir, rm } = await import("node:fs/promises");
    const foreign = path.join(path.dirname(cwd), "app.worktrees", "foreign");
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, "x.txt"), "not a worktree");
    await expect(openWorktree(cwd, "foreign")).rejects.toThrow("not a worktree of this repository");
    const made = await openWorktree(cwd, "gone");
    await rm(made.path, { recursive: true, force: true });
    const again = await openWorktree(cwd, "gone");
    expect(again.created).toBe(true);
  });

  it("clear messages: no commits yet; bad names; an empty --worktree= picks a name", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "aegis-wt-empty-"));
    execFileSync("git", ["init", "-q", "-b", "main", base]);
    await expect(openWorktree(base, "x")).rejects.toThrow("at least one commit");
    const cwd = await repo();
    for (const bad of ["a.lock", "a.", "CON", "nul.txt"]) await expect(openWorktree(cwd, bad), bad).rejects.toThrow("not a usable worktree name");
    expect(parseArgs(["--worktree="]).worktree).toMatch(/^session-/);
  });
});

describe("--worktree: review fixes (6e05349)", () => {
  it("a hand-made .git file naming another project does not borrow its trust, rules or .env", async () => {
    const { mainCheckoutOf } = await import("../src/env.ts");
    const { projectKey } = await import("../src/rules.ts");
    const trusted = await repo();
    const real = await openWorktree(trusted, "real");
    expect(mainCheckoutOf(real.path)).toBe(trusted);
    const evil = await mkdtemp(path.join(os.tmpdir(), "aegis-wt-evil-"));
    await writeFile(path.join(evil, ".git"), `gitdir: ${path.join(trusted, ".git", "worktrees", "nope")}\n`);
    expect(mainCheckoutOf(evil)).toBeUndefined();
    // Pointing at a real worktree's record is refused too: that record points back at the real worktree.
    await writeFile(path.join(evil, ".git"), `gitdir: ${path.join(trusted, ".git", "worktrees", "real")}\n`);
    expect(mainCheckoutOf(evil)).toBeUndefined();
    expect(projectKey(evil)).not.toBe(projectKey(trusted));
  });

  it("clear errors: a file in the way, and git's real reason", async () => {
    const cwd = await repo();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(path.dirname(cwd), "app.worktrees"), { recursive: true });
    await writeFile(path.join(path.dirname(cwd), "app.worktrees", "file"), "x");
    await expect(openWorktree(cwd, "file")).rejects.toThrow("not a worktree of this repository");
    // The branch is already checked out in another worktree.
    git(cwd, "worktree", "add", "-q", "-b", "aegis/busy", path.join(path.dirname(cwd), "elsewhere"));
    await expect(openWorktree(cwd, "busy")).rejects.toThrow(/could not create the worktree: (fatal|error):/);
  });
});
