import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { findOnPath, windowsPowerShell } from "../which.ts";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isGitRepo(cwd: string) {
  return existsSync(path.join(cwd, ".git"));
}

let resolvedShell: string | undefined;

/**
 * Which PowerShell to run. Like Pi: PowerShell 7 (pwsh) when installed, otherwise Windows PowerShell 5.1.
 * AEGIS_POWERSHELL overrides it.
 */
export function powershellExe() {
  const override = process.env.AEGIS_POWERSHELL;
  // A bare name is looked up on PATH like everything else (never in the project folder).
  if (override) return path.isAbsolute(override) ? override : (findOnPath(override) ?? windowsPowerShell());
  if (resolvedShell) return resolvedShell;
  // Full paths only: a bare name would let a pwsh.exe in the project folder run instead (see which.ts).
  resolvedShell = findOnPath("pwsh") ?? (process.platform === "win32" ? windowsPowerShell() : "pwsh");
  return resolvedShell;
}

export async function runPowerShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const running = execFileAsync(
    powershellExe(),
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 2_000_000, signal },
  );
  // Nothing is ever typed into the command: close stdin so PowerShell never waits on an open pipe.
  running.child.stdin?.end();
  const { stdout, stderr } = await running;
  return {
    stdout: stdout.trimEnd(),
    stderr: stderr.trimEnd(),
  };
}
