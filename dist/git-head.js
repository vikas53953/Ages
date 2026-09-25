/**
 * The current git branch for the footer, read from .git/HEAD (like Pi's footer). No git program runs: a
 * repository's config cannot make this execute anything, and it costs one small file read.
 */
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
/**
 * A small regular file's text, or undefined. Checked before opening: a named pipe called HEAD would block a
 * plain read forever (and freeze the TUI), and a huge file is not read whole.
 */
function smallFile(file, limit = 4096) {
    try {
        // Opened without blocking and checked on the open file: a pipe swapped in after a check cannot hang the read.
        const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
        try {
            const info = fstatSync(fd);
            if (!info.isFile() || info.size > limit)
                return undefined;
            const buf = Buffer.alloc(limit);
            const length = readSync(fd, buf, 0, limit, 0);
            return buf.subarray(0, length).toString("utf8");
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return undefined;
    }
}
/** The git folder for `cwd`: .git itself, or where a worktree's ".git" file points. Searched upward. */
function gitDir(cwd) {
    let dir = path.resolve(cwd);
    for (let depth = 0; depth < 64; depth += 1) {
        const candidate = path.join(dir, ".git");
        try {
            const info = statSync(candidate);
            if (info.isDirectory())
                return candidate;
            if (info.isFile()) {
                const target = /^gitdir:\s*(.+)$/m.exec(smallFile(candidate) ?? "")?.[1]?.trim();
                return target ? path.resolve(dir, target) : undefined;
            }
        }
        catch {
            // not here: look one folder up
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
    return undefined;
}
/** "main", "aegis/fix-login", a short commit id when detached, or undefined outside a repository. */
export function gitBranch(cwd) {
    const dir = gitDir(cwd);
    if (!dir)
        return undefined;
    const head = smallFile(path.join(dir, "HEAD"))?.trim();
    if (!head)
        return undefined;
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
    // Only the characters branch names use: a crafted HEAD must not put escape codes into your terminal.
    if (ref)
        return ref.replace(/[^\w./@+-]/g, "?").slice(0, 80);
    return /^[0-9a-f]{7,64}$/i.test(head) ? head.slice(0, 7) : undefined;
}
/** Cached for a moment: the footer repaints four times a second while a turn runs. */
export function cachedGitBranch(ms = 2_000) {
    let at = 0;
    let cwdSeen = "";
    let value;
    return (cwd) => {
        const now = Date.now();
        if (cwd !== cwdSeen || now - at > ms) {
            value = gitBranch(cwd);
            at = now;
            cwdSeen = cwd;
        }
        return value;
    };
}
