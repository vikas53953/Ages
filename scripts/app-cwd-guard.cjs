/**
 * Preload for generated inventory Node. Confines fs to AEGIS_APP_ROOT.
 * Not OS isolation. Jev and shell-off do not sandbox generated Node.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const Module = require("node:module");

const ROOT = (() => {
  const raw = path.resolve(process.env.AEGIS_APP_ROOT || process.cwd());
  try {
    return fs.realpathSync(raw);
  } catch {
    return raw;
  }
})();

function asPath(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  if (value instanceof URL) return fileURLToPath(value);
  if (typeof value === "object" && typeof value.href === "string") {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function resolved(target) {
  let dir = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(target);
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

function assertInside(value, op) {
  const raw = asPath(value);
  if (!raw) return;
  const dest = resolved(raw);
  const rel = path.relative(ROOT, dest);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Aegis app cwd-guard: ${op} refused outside app root`);
  }
}

function wrap(obj, name, indexes) {
  const orig = obj[name];
  if (typeof orig !== "function") return;
  obj[name] = function wrapped(...args) {
    for (const index of indexes) {
      if (args[index] !== undefined) assertInside(args[index], name);
    }
    return orig.apply(this, args);
  };
}

const singles = [
  "access",
  "accessSync",
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "createReadStream",
  "createWriteStream",
  "lstat",
  "lstatSync",
  "mkdir",
  "mkdirSync",
  "open",
  "openSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "stat",
  "statSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "writeFile",
  "writeFileSync",
];
const pairs = [
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "link",
  "linkSync",
  "rename",
  "renameSync",
  "symlink",
  "symlinkSync",
];

for (const name of singles) wrap(fs, name, [0]);
for (const name of pairs) wrap(fs, name, [0, 1]);
for (const name of singles) wrap(fs.promises, name, [0]);
for (const name of pairs) wrap(fs.promises, name, [0, 1]);

if (typeof Module.syncBuiltinESMExports === "function") {
  Module.syncBuiltinESMExports();
}
