#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = pathToFileURL(path.join(root, "node_modules", "tsx", "dist", "esm", "index.mjs")).href;
const cli = path.join(root, "src", "cli.ts");
const child = spawn(process.execPath, ["--import", tsx, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
