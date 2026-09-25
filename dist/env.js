import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
export function parseEnvText(text) {
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const eq = line.indexOf("=");
        if (eq <= 0)
            continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}
/**
 * What a project's own .env / .env.local may set: model names and API keys, nothing else. A cloned repo must not
 * be able to switch on the shell, swap the Claude or PowerShell program, move Aegis's home (and with it your
 * trusted MCP servers and sign-ins), or send your ChatGPT token to another server.
 */
export const PROJECT_ENV_KEYS = new Set([
    "OPENCODE_API_KEY",
    "OPENAI_API_KEY",
    "TYPESAFE_API_KEY",
    "TYPESAFE_AI_API_KEY",
    "BRAVE_API_KEY",
    "GATE_CHEAP_MODEL",
    "GATE_FRONTIER_MODEL",
]);
/** Names a project .env tried to set and Aegis ignored (shown by /doctor). */
export const ignoredProjectEnv = new Set();
function applyEnvFile(file, allow) {
    if (!existsSync(file))
        return;
    const parsed = parseEnvText(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
        // Where Aegis keeps your settings comes only from the real environment, never from a file.
        if (key === "AEGIS_HOME")
            continue;
        if (allow && !allow(key)) {
            ignoredProjectEnv.add(key);
            continue;
        }
        process.env[key] = value;
    }
}
export function packageRoot() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}
/** Per-user Aegis folder: keys and defaults shared by every project. AEGIS_HOME overrides it (tests). */
export function userAegisDir() {
    return process.env.AEGIS_HOME ? path.resolve(process.env.AEGIS_HOME) : path.join(os.homedir(), ".aegis");
}
/**
 * The main checkout of a linked git worktree (`aegis --worktree`, or any `git worktree add`): its `.git` is a file
 * "gitdir: <main>/.git/worktrees/<name>". Undefined for an ordinary folder. Trust, your saved rules and the
 * project's .env belong to the project, so a worktree shares them with its main checkout.
 */
export function mainCheckoutOf(cwd) {
    try {
        const text = readFileSync(path.join(cwd, ".git"), "utf8");
        const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
        if (!gitdir)
            return undefined;
        const absolute = path.resolve(cwd, gitdir);
        const worktrees = path.dirname(absolute);
        if (path.basename(worktrees) !== "worktrees" || path.basename(path.dirname(worktrees)) !== ".git")
            return undefined;
        // The main checkout's record must point back at this folder: a hand-made ".git" file naming some other
        // project would otherwise borrow that project's trust, saved rules and .env.
        const back = readFileSync(path.join(absolute, "gitdir"), "utf8").trim();
        if (realpathSync.native(path.dirname(path.resolve(absolute, back))) !== realpathSync.native(cwd))
            return undefined;
        return path.dirname(path.dirname(worktrees));
    }
    catch {
        return undefined;
    }
}
export function loadEnv(cwd = process.cwd()) {
    const root = packageRoot();
    applyEnvFile(path.join(root, ".env"));
    applyEnvFile(path.join(root, ".env.local"));
    // Keys saved once for every folder (like Pi's login): %USERPROFILE%\.aegis\.env. A project .env still wins.
    applyEnvFile(path.join(userAegisDir(), ".env"));
    const projectKey = (key) => PROJECT_ENV_KEYS.has(key);
    // A worktree has no copy of the (git-ignored) .env: its main checkout's applies, then its own if any.
    const main = mainCheckoutOf(cwd);
    if (main) {
        applyEnvFile(path.join(main, ".env"), projectKey);
        applyEnvFile(path.join(main, ".env.local"), projectKey);
    }
    applyEnvFile(path.join(cwd, ".env"), projectKey);
    applyEnvFile(path.join(cwd, ".env.local"), projectKey);
    return loadConfig(cwd);
}
export function hasJevCredentials() {
    return Boolean(process.env.TYPESAFE_API_KEY ||
        process.env.TYPESAFE_AI_API_KEY ||
        process.env.AI_GATEWAY_API_KEY);
}
export function jevApiKey() {
    return (process.env.TYPESAFE_API_KEY ||
        process.env.TYPESAFE_AI_API_KEY ||
        process.env.AI_GATEWAY_API_KEY ||
        "");
}
export function hasOpenAiKey() {
    return Boolean(process.env.OPENAI_API_KEY);
}
export function hasOpenCodeKey() {
    return Boolean(process.env.OPENCODE_API_KEY);
}
export function lexicalInsideCwd(target, cwd) {
    const resolved = path.resolve(cwd, target);
    const root = path.resolve(cwd);
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Path is outside the working folder: ${target}`);
    }
    return resolved;
}
export function checkerScriptPath() {
    return path.join(packageRoot(), "scripts", "check-device-inventory.mjs");
}
function checkerPaths(cwd) {
    return [checkerScriptPath(), path.join(path.resolve(cwd), "scripts", "check-device-inventory.mjs")];
}
function isInsideDir(root, candidate) {
    const rel = path.relative(path.resolve(root), path.resolve(candidate));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function isCheckerPath(resolvedPath, cwd) {
    return checkerPaths(cwd).some((file) => isInsideDir(file, resolvedPath) && isInsideDir(resolvedPath, file));
}
export function assertNotDeliveryRecord(relativePath, cwd) {
    const intended = lexicalInsideCwd(relativePath, cwd);
    const rel = path.relative(path.resolve(cwd), intended);
    const top = rel.split(/[/\\]/)[0]?.toLowerCase();
    if (top === ".harness" || top === ".git") {
        throw new Error("Delivery records are not writable by tools.");
    }
    if (isCheckerPath(intended, cwd)) {
        throw new Error("Checker script is not writable by tools.");
    }
}
async function assertResolvedNotProtected(resolvedPath, cwd) {
    const dest = path.resolve(resolvedPath);
    if (isCheckerPath(dest, cwd)) {
        throw new Error("Checker script is not writable by tools.");
    }
    const root = await realpathOrSelf(path.resolve(cwd));
    const harness = await realpathOrSelf(path.join(root, ".harness"));
    const git = await realpathOrSelf(path.join(root, ".git"));
    if (isInsideDir(harness, dest) || isInsideDir(git, dest)) {
        throw new Error("Delivery records are not writable by tools.");
    }
    const rel = path.relative(root, dest);
    const parts = rel.split(/[/\\]/).map((part) => part.toLowerCase());
    if (parts.includes(".harness") || parts.includes(".git")) {
        throw new Error("Delivery records are not writable by tools.");
    }
}
function assertRelInside(root, candidate, label) {
    const rel = path.relative(root, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Path is outside the working folder: ${label}`);
    }
}
async function realpathOrSelf(target) {
    try {
        return await realpath(target);
    }
    catch {
        return path.resolve(target);
    }
}
export async function assertInsideCwd(target, cwd) {
    const intended = lexicalInsideCwd(target, cwd);
    const root = await realpathOrSelf(path.resolve(cwd));
    try {
        const st = await lstat(intended);
        if (st.isSymbolicLink() || st.isFile() || st.isDirectory()) {
            const real = await realpath(intended);
            assertRelInside(root, real, target);
            return real;
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const rest = [];
    let dir = path.dirname(intended);
    rest.unshift(path.basename(intended));
    while (true) {
        try {
            const realDir = await realpath(dir);
            assertRelInside(root, realDir, target);
            const planned = path.resolve(realDir, ...rest);
            assertRelInside(root, planned, target);
            return planned;
        }
        catch (error) {
            if (error.message?.startsWith("Path is outside"))
                throw error;
            const parent = path.dirname(dir);
            if (parent === dir) {
                assertRelInside(root, intended, target);
                return intended;
            }
            rest.unshift(path.basename(dir));
            dir = parent;
        }
    }
}
async function isLink(target) {
    try {
        return (await lstat(target)).isSymbolicLink();
    }
    catch {
        return false;
    }
}
/** Walk until an existing path, realpath it, refuse if it is outside cwd. */
async function existingRealDirInsideCwd(start, root, label) {
    const rest = [];
    let dir = start;
    while (true) {
        try {
            const real = await realpath(dir);
            assertRelInside(root, real, label);
            const info = await stat(real);
            if (!info.isDirectory()) {
                throw new Error(`Path is outside the working folder: ${label}`);
            }
            return { real, rest };
        }
        catch (error) {
            if (error.message?.startsWith("Path is outside"))
                throw error;
            const code = error.code;
            if (code && code !== "ENOENT")
                throw error;
            const parent = path.dirname(dir);
            if (parent === dir) {
                throw new Error(`Path is outside the working folder: ${label}`);
            }
            rest.unshift(path.basename(dir));
            dir = parent;
        }
    }
}
/** Write through the real parent directory. Never follow a dest link. mkdir only after that check. */
export async function writeFileInsideCwd(relativePath, contents, cwd) {
    assertNotDeliveryRecord(relativePath, cwd);
    const intended = lexicalInsideCwd(relativePath, cwd);
    const root = await realpathOrSelf(path.resolve(cwd));
    const parentLex = path.dirname(intended);
    const located = await existingRealDirInsideCwd(parentLex, root, relativePath);
    const destParent = located.rest.length
        ? path.join(located.real, ...located.rest)
        : located.real;
    assertRelInside(root, destParent, relativePath);
    await assertResolvedNotProtected(destParent, cwd);
    await assertResolvedNotProtected(located.real, cwd);
    if (located.rest.length) {
        await mkdir(destParent, { recursive: true });
    }
    const parentReal = await realpath(destParent);
    assertRelInside(root, parentReal, relativePath);
    await assertResolvedNotProtected(parentReal, cwd);
    const dest = path.join(parentReal, path.basename(intended));
    assertRelInside(root, dest, relativePath);
    await assertResolvedNotProtected(dest, cwd);
    const tmp = path.join(parentReal, `.aegis-tmp-${randomUUID()}`);
    try {
        await writeFile(tmp, contents, { encoding: "utf8", flag: "wx" });
        const parentNow = await realpath(destParent);
        if (path.resolve(parentNow) !== path.resolve(parentReal)) {
            throw new Error(`Path is outside the working folder: ${relativePath}`);
        }
        assertRelInside(root, parentNow, relativePath);
        await assertResolvedNotProtected(parentNow, cwd);
        if (await isLink(dest))
            await unlink(dest);
        await rename(tmp, dest);
    }
    catch (error) {
        await unlink(tmp).catch(() => undefined);
        throw error;
    }
    if (await isLink(dest)) {
        await unlink(dest).catch(() => undefined);
        throw new Error(`Path is outside the working folder: ${relativePath}`);
    }
    const real = await realpath(dest);
    assertRelInside(root, real, relativePath);
    await assertResolvedNotProtected(real, cwd);
    return real;
}
export async function assertWrittenInsideCwd(target, cwd) {
    const root = await realpathOrSelf(path.resolve(cwd));
    if (await isLink(target)) {
        await unlink(target).catch(() => undefined);
        throw new Error(`Path is outside the working folder: ${target}`);
    }
    try {
        const real = await realpath(target);
        assertRelInside(root, real, target);
        await assertResolvedNotProtected(real, cwd);
    }
    catch {
        try {
            await unlink(target);
        }
        catch {
            // ignore
        }
        throw new Error(`Path is outside the working folder: ${target}`);
    }
}
