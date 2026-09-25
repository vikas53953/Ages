/**
 * aegis --worktree[=name] (Claude Code's --worktree): work in a separate git worktree on its own branch, so the
 * agent's changes never touch your checkout until you merge them. The worktree sits next to the repository:
 * <repo>.worktrees/<name>, on branch aegis/<name>; starting again with the same name reuses it.
 *
 * git runs hardened (review.ts): a repo's hooks, filters and fsmonitor do not run while the files are checked
 * out. Git LFS files therefore stay pointer files; run `git lfs pull` in the worktree yourself if you need them.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { filterOverrides, git } from "./review.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

export function defaultWorktreeName(now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `session-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export async function openWorktree(cwd: string, name: string): Promise<{ path: string; branch: string; created: boolean }> {
  if (!NAME.test(name) || name.includes("..")) throw new Error(`"${name}" is not a usable worktree name (letters, digits, . _ - ; up to 60)`);
  let top: string;
  try {
    top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error("--worktree needs a git repository with at least one commit");
  }
  const folder = path.join(path.dirname(top), `${path.basename(top)}.worktrees`, name);
  const branch = `aegis/${name}`;
  if (existsSync(path.join(folder, ".git"))) return { path: folder, branch, created: false };
  const noFilters = await filterOverrides(top);
  let branchExists = true;
  try {
    await git(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}`]);
  } catch {
    branchExists = false;
  }
  await git(top, branchExists ? ["worktree", "add", "--", folder, branch] : ["worktree", "add", "-b", branch, "--", folder, "HEAD"], noFilters);
  return { path: folder, branch, created: true };
}
