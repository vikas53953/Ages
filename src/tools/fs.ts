import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { killProcessTree, ownGroup, releaseGroup } from "../exec.ts";
import { findOnPath, windowsPowerShell } from "../which.ts";


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

const MAX_SHELL_OUTPUT = 2_000_000;

/**
 * Run one PowerShell command. Its own process group on POSIX, so a timeout or stop ends everything it started
 * (taskkill /T on Windows). Resolves {stdout, stderr} on exit code 0; otherwise rejects with an error that
 * carries stdout, stderr, code and killed, like execFile's.
 */
export function runPowerShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const pid = child.pid;
    ownGroup(pid);
    let stdout = "";
    let stderr = "";
    let killed = false;
    let overflow = false;
    let settled = false;
    const killTree = () => {
      killed = true;
      if (pid) killProcessTree(pid);
    };
    const timer = setTimeout(killTree, timeoutMs);
    const onAbort = () => killTree();
    if (signal?.aborted) killTree();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const take = (chunk: Buffer, into: "out" | "err") => {
      if (stdout.length + stderr.length + chunk.length > MAX_SHELL_OUTPUT) {
        overflow = true;
        killTree();
        return;
      }
      if (into === "out") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => take(chunk, "out"));
    child.stderr.on("data", (chunk: Buffer) => take(chunk, "err"));
    const finish = (error: Error | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      releaseGroup(pid);
      if (!error) resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
      else reject(Object.assign(error, { stdout, stderr }));
    };
    child.on("error", (error) => finish(Object.assign(error, { code: (error as NodeJS.ErrnoException).code })));
    child.on("close", (code, closeSignal) => {
      if (code === 0 && !killed) return finish(undefined);
      const why = signal?.aborted ? "stopped" : overflow ? "output over 2 MB" : killed ? `timed out after ${timeoutMs} ms` : `exit code ${code}`;
      finish(
        Object.assign(new Error(`Command failed (${why}): ${command}`), {
          code: overflow ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : (code ?? undefined),
          killed: killed && !overflow,
          signal: closeSignal ?? undefined,
        }),
      );
    });
    // Nothing is ever typed into the command: close stdin so PowerShell never waits on an open pipe.
    child.stdin.end();
  });
}
