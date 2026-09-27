/**
 * aegis --worktree[=name] (Claude Code's --worktree): work in a separate git worktree on its own branch, so the
 * agent's changes never touch your checkout until you merge them. The worktree sits next to the repository:
 * <repo>.worktrees/<name>, on branch aegis/<name>; starting again with the same name reuses it.
 *
 * git runs hardened (review.ts): a repo's hooks, filters and fsmonitor do not run while the files are checked
 * out. Git LFS files therefore stay pointer files; run `git lfs pull` in the worktree yourself if you need them.
 */
import { readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { filterOverrides, git } from "./review.js";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
/** Names Windows cannot use for a folder. */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** A checkout of a big repository on a slow disk (and Defender) takes a while; git's own default is no limit. */
const CHECKOUT_TIMEOUT_MS = 30 * 60_000;
export function defaultWorktreeName(now = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `session-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
function checkName(name) {
    if (!NAME.test(name) || name.includes("..") || name.endsWith(".") || name.endsWith(".lock") || RESERVED.test(name)) {
        throw new Error(`"${name}" is not a usable worktree name (letters, digits, . _ - ; up to 60; not ending in . or .lock)`);
    }
}
/** The repository's shared .git folder, as a real path (the same for the main checkout and every worktree). */
async function commonDir(cwd) {
    const dir = (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    return realpath(dir).catch(() => dir);
}
export async function openWorktree(cwd, name) {
    checkName(name);
    let common;
    try {
        common = await commonDir(cwd);
    }
    catch {
        throw new Error("--worktree needs a git repository");
    }
    // Next to the main checkout, also when started from inside another worktree (no nesting).
    if (path.basename(common) !== ".git")
        throw new Error("--worktree needs a repository with a working folder (not a bare one)");
    const top = path.dirname(common);
    try {
        await git(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    }
    catch {
        throw new Error("--worktree needs at least one commit in the repository");
    }
    const folder = path.join(path.dirname(top), `${path.basename(top)}.worktrees`, name);
    const branch = `aegis/${name}`;
    const existing = await stat(folder).catch(() => undefined);
    if (existing && !existing.isDirectory())
        throw new Error(`${folder} already exists and is not a worktree of this repository`);
    if (existing && (await readdir(folder)).length) {
        // Reuse only a worktree of this very repository; report the branch it is really on.
        let theirs = "";
        try {
            theirs = await commonDir(folder);
        }
        catch {
            // not a repository at all
        }
        if (theirs !== common)
            throw new Error(`${folder} already exists and is not a worktree of this repository`);
        // Empty when its HEAD is detached: say so rather than guess.
        const current = (await git(folder, ["branch", "--show-current"]).catch(() => "")).trim();
        return { path: folder, branch: current || "(detached HEAD)", created: false };
    }
    // A worktree folder deleted by hand is still registered: forget it first, or git refuses.
    await git(top, ["worktree", "prune"]).catch(() => "");
    const noFilters = await filterOverrides(top);
    let branchExists = true;
    try {
        await git(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}`]);
    }
    catch {
        branchExists = false;
    }
    try {
        await git(top, branchExists ? ["worktree", "add", "--", folder, branch] : ["worktree", "add", "-b", branch, "--", folder, "HEAD"], noFilters, CHECKOUT_TIMEOUT_MS);
    }
    catch (error) {
        // Leave nothing half-made behind, so the next try starts clean.
        await rm(folder, { recursive: true, force: true }).catch(() => undefined);
        await git(top, ["worktree", "prune"]).catch(() => "");
        if (!branchExists)
            await git(top, ["branch", "-D", "--", branch]).catch(() => "");
        // git prints progress first ("Preparing worktree …"): show its fatal/error line, else its last line.
        const lines = String(error.stderr ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const reason = lines.find((line) => /^(?:fatal|error):/.test(line)) ?? lines.at(-1);
        throw new Error(`could not create the worktree: ${reason || (error instanceof Error ? error.message.split("\n")[0] : String(error))}`);
    }
    return { path: folder, branch, created: true };
}
