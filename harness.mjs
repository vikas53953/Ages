#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "src", "cli.ts");
const child = spawn(process.execPath, ["--import", "tsx", cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
});
child.on("exit", (code) => process.exit(code ?? 0));
