import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function applyEnvFile(file: string) {
  if (!existsSync(file)) return;
  const parsed = parseEnvText(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] = value;
  }
}

export function packageRoot() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadEnv(cwd = process.cwd()) {
  const root = packageRoot();
  applyEnvFile(path.join(root, ".env"));
  applyEnvFile(path.join(root, ".env.local"));
  applyEnvFile(path.join(cwd, ".env"));
  applyEnvFile(path.join(cwd, ".env.local"));
  return loadConfig(cwd);
}

export function hasJevCredentials() {
  return Boolean(
    process.env.TYPESAFE_API_KEY ||
      process.env.TYPESAFE_AI_API_KEY ||
      process.env.AI_GATEWAY_API_KEY,
  );
}

export function jevApiKey() {
  return (
    process.env.TYPESAFE_API_KEY ||
    process.env.TYPESAFE_AI_API_KEY ||
    process.env.AI_GATEWAY_API_KEY ||
    ""
  );
}

export function hasOpenAiKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function hasOpenCodeKey() {
  return Boolean(process.env.OPENCODE_API_KEY);
}

export function lexicalInsideCwd(target: string, cwd: string) {
  const resolved = path.resolve(cwd, target);
  const root = path.resolve(cwd);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the working folder: ${target}`);
  }
  return resolved;
}

export function assertNotDeliveryRecord(relativePath: string, cwd: string) {
  const intended = lexicalInsideCwd(relativePath, cwd);
  const rel = path.relative(path.resolve(cwd), intended);
  const top = rel.split(/[/\\]/)[0]?.toLowerCase();
  if (top === ".harness" || top === ".git") {
    throw new Error("Delivery records are not writable by tools.");
  }
}

function assertRelInside(root: string, candidate: string, label: string) {
  const rel = path.relative(root, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the working folder: ${label}`);
  }
}

async function realpathOrSelf(target: string) {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

export async function assertInsideCwd(target: string, cwd: string) {
  const intended = lexicalInsideCwd(target, cwd);
  const root = await realpathOrSelf(path.resolve(cwd));
  try {
    const st = await lstat(intended);
    if (st.isSymbolicLink() || st.isFile() || st.isDirectory()) {
      const real = await realpath(intended);
      assertRelInside(root, real, target);
      return real;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const rest: string[] = [];
  let dir = path.dirname(intended);
  rest.unshift(path.basename(intended));
  while (true) {
    try {
      const realDir = await realpath(dir);
      assertRelInside(root, realDir, target);
      const planned = path.resolve(realDir, ...rest);
      assertRelInside(root, planned, target);
      return planned;
    } catch (error) {
      if ((error as Error).message?.startsWith("Path is outside")) throw error;
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

async function isLink(target: string) {
  try {
    return (await lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Walk until an existing path, realpath it, refuse if it is outside cwd. */
async function existingRealDirInsideCwd(start: string, root: string, label: string) {
  const rest: string[] = [];
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
    } catch (error) {
      if ((error as Error).message?.startsWith("Path is outside")) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "ENOENT") throw error;
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
export async function writeFileInsideCwd(relativePath: string, contents: string, cwd: string) {
  assertNotDeliveryRecord(relativePath, cwd);
  const intended = lexicalInsideCwd(relativePath, cwd);
  const root = await realpathOrSelf(path.resolve(cwd));
  const parentLex = path.dirname(intended);
  const located = await existingRealDirInsideCwd(parentLex, root, relativePath);
  const destParent = located.rest.length
    ? path.join(located.real, ...located.rest)
    : located.real;
  assertRelInside(root, destParent, relativePath);
  if (located.rest.length) {
    await mkdir(destParent, { recursive: true });
  }
  const parentReal = await realpath(destParent);
  assertRelInside(root, parentReal, relativePath);
  const dest = path.join(parentReal, path.basename(intended));
  assertRelInside(root, dest, relativePath);
  const tmp = path.join(parentReal, `.aegis-tmp-${randomUUID()}`);
  try {
    await writeFile(tmp, contents, { encoding: "utf8", flag: "wx" });
    const parentNow = await realpath(destParent);
    if (path.resolve(parentNow) !== path.resolve(parentReal)) {
      throw new Error(`Path is outside the working folder: ${relativePath}`);
    }
    assertRelInside(root, parentNow, relativePath);
    if (await isLink(dest)) await unlink(dest);
    await rename(tmp, dest);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  if (await isLink(dest)) {
    await unlink(dest).catch(() => undefined);
    throw new Error(`Path is outside the working folder: ${relativePath}`);
  }
  const real = await realpath(dest);
  assertRelInside(root, real, relativePath);
  return real;
}

export async function assertWrittenInsideCwd(target: string, cwd: string) {
  const root = await realpathOrSelf(path.resolve(cwd));
  if (await isLink(target)) {
    await unlink(target).catch(() => undefined);
    throw new Error(`Path is outside the working folder: ${target}`);
  }
  try {
    const real = await realpath(target);
    assertRelInside(root, real, target);
  } catch {
    try {
      await unlink(target);
    } catch {
      // ignore
    }
    throw new Error(`Path is outside the working folder: ${target}`);
  }
}
