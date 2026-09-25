import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { assertInsideCwd } from "../env.js";
/** Never searched, whatever .gitignore says. */
const SKIP = new Set(["node_modules", ".git", ".gate", ".harness", "dist", "coverage"]);
const MAX_HITS = 100;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2_000_000;
function inside(root, candidate) {
    const rel = path.relative(root, candidate);
    if (rel === "")
        return true;
    return !rel.startsWith("..") && !path.isAbsolute(rel);
}
/** A glob's regex body ("*" stays in one folder, "**" crosses folders, "?" one character, {a,b} either). */
function globBody(glob) {
    let body = "";
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === "*") {
            if (glob[i + 1] === "*") {
                const slash = glob[i + 2] === "/";
                body += slash ? "(?:.*/)?" : ".*";
                i += slash ? 2 : 1;
            }
            else
                body += "[^/]*";
        }
        else if (ch === "?")
            body += "[^/]";
        else if (ch === "{" && glob.indexOf("}", i) > i) {
            const end = glob.indexOf("}", i);
            body += `(?:${glob
                .slice(i + 1, end)
                .split(",")
                .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
                .join("|")})`;
            i = end;
        }
        else
            body += ch.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
    }
    return body;
}
const FLAGS = process.platform === "win32" ? "i" : "";
/**
 * A glob ("src/**\/*.ts", "*.md") as a regex over "/"-separated relative paths. Without a "/" it matches the
 * name in any folder (like ripgrep's --glob and .gitignore); with one, from the top.
 */
export function globRegex(glob) {
    const clean = glob.replace(/^\.\//, "");
    return clean.includes("/") ? new RegExp(`^${globBody(clean.replace(/^\//, ""))}$`, FLAGS) : new RegExp(`(^|/)${globBody(clean)}$`, FLAGS);
}
/** The folder's .gitignore, simply: plain and glob patterns, "dir/" for folders, "!" re-includes. */
async function loadIgnore(root) {
    let text = "";
    try {
        text = await readFile(path.join(root, ".gitignore"), "utf8");
    }
    catch {
        return () => false;
    }
    const rules = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
        const negate = line.startsWith("!");
        let pattern = negate ? line.slice(1) : line;
        const dirOnly = pattern.endsWith("/");
        if (dirOnly)
            pattern = pattern.slice(0, -1);
        // A "/" at the start or in the middle ties the pattern to the top of the folder (git's rule).
        const anchored = pattern.includes("/");
        pattern = pattern.replace(/^\//, "");
        const regex = anchored ? new RegExp(`^${globBody(pattern)}$`, FLAGS) : new RegExp(`(^|/)${globBody(pattern)}$`, FLAGS);
        return { negate, dirOnly, regex };
    });
    return (relative, isDir) => {
        let ignored = false;
        for (const rule of rules) {
            if (rule.dirOnly && !isDir)
                continue;
            if (rule.regex.test(relative))
                ignored = !rule.negate;
        }
        return ignored;
    };
}
/** Files under root (links followed only inside it), minus SKIP and .gitignore. */
export async function walkFiles(root, limit = 20_000) {
    const ignored = await loadIgnore(root);
    const out = [];
    const visit = async (dir) => {
        if (out.length >= limit)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (out.length >= limit)
                return;
            if (SKIP.has(entry.name))
                continue;
            const full = path.join(dir, entry.name);
            let real = full;
            try {
                real = await realpath(full);
            }
            catch {
                continue;
            }
            if (!inside(root, real))
                continue;
            const info = await stat(real).catch(() => undefined);
            if (!info)
                continue;
            const relative = path.relative(root, full).split(path.sep).join("/");
            if (ignored(relative, info.isDirectory()))
                continue;
            if (info.isDirectory())
                await visit(real);
            else if (info.isFile())
                out.push({ file: real, relative });
        }
    };
    await visit(root);
    return out;
}
async function looksBinary(file) {
    const handle = await open(file, "r");
    try {
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).includes(0);
    }
    finally {
        await handle.close();
    }
}
export async function grepPath(pattern, relativePath, cwd, options = {}) {
    const root = await assertInsideCwd(relativePath || ".", cwd);
    const info = await stat(root);
    let regex;
    try {
        regex = new RegExp(pattern, options.caseSensitive ? "" : "i");
    }
    catch (error) {
        return `bad pattern: ${error instanceof Error ? error.message : String(error)}`;
    }
    const only = options.glob ? globRegex(options.glob) : undefined;
    const files = info.isDirectory()
        ? (await walkFiles(root)).filter((entry) => !only || only.test(entry.relative)).map((entry) => entry.file)
        : [root];
    const context = Math.max(0, Math.min(5, Math.floor(options.context ?? 0)));
    const hits = [];
    let total = 0;
    for (const file of files) {
        let body = "";
        try {
            if ((await stat(file)).size > MAX_FILE_BYTES || (await looksBinary(file)))
                continue;
            body = await readFile(file, "utf8");
        }
        catch {
            continue;
        }
        const lines = body.split(/\r?\n/);
        const shown = path.relative(cwd, file).split(path.sep).join("/");
        lines.forEach((line, index) => {
            if (!regex.test(line))
                return;
            total += 1;
            if (hits.length >= MAX_HITS)
                return;
            if (!context) {
                hits.push(`${shown}:${index + 1}:${line.trim()}`);
                return;
            }
            const from = Math.max(0, index - context);
            const to = Math.min(lines.length, index + context + 1);
            hits.push(lines
                .slice(from, to)
                .map((text, offset) => `${shown}${from + offset === index ? ":" : "-"}${from + offset + 1}${from + offset === index ? ":" : "-"}${text}`)
                .join("\n") + "\n--");
        });
    }
    if (!hits.length)
        return "no matches";
    const more = total > hits.length ? `\n[… ${total - hits.length} more matches not shown; narrow the pattern, path or glob]` : "";
    return hits.join("\n") + more;
}
/** File paths matching a glob, newest first (like Claude Code's Glob). */
export async function globPath(pattern, relativePath, cwd) {
    const root = await assertInsideCwd(relativePath || ".", cwd);
    const regex = globRegex(pattern);
    const matched = (await walkFiles(root)).filter((entry) => regex.test(entry.relative));
    const dated = await Promise.all(matched.map(async (entry) => ({ entry, time: (await stat(entry.file).catch(() => undefined))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => b.time - a.time);
    const shown = dated.slice(0, MAX_FILES).map(({ entry }) => path.relative(cwd, entry.file).split(path.sep).join("/"));
    if (!shown.length)
        return "no files match";
    return shown.join("\n") + (dated.length > MAX_FILES ? `\n[… ${dated.length - MAX_FILES} more files not shown]` : "");
}
