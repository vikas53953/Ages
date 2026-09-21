import { spawn } from "node:child_process";
import path from "node:path";

const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--mock-jev", "--local", "--repl"], {
  cwd: path.resolve("."),
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let out = "";
child.stdout.on("data", (chunk) => {
  out += String(chunk);
});
child.stderr.on("data", (chunk) => {
  out += String(chunk);
});

child.stdin.write("/help\n");
child.stdin.write("/models\n");
child.stdin.write("/status\n");
child.stdin.write("/skills\n");
child.stdin.write("/compact\n");
child.stdin.write("/exit\n");
child.stdin.end();

child.on("close", (code) => {
  process.stdout.write(out);
  process.exit(code ?? 1);
});
