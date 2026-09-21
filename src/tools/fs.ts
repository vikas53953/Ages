import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isGitRepo(cwd: string) {
  return existsSync(path.join(cwd, ".git"));
}

export async function runPowerShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const { stdout, stderr } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 2_000_000, signal },
  );
  return {
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
  };
}
