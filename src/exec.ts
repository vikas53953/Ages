import { spawn, spawnSync } from "node:child_process";
import { programPath, system32 } from "./which.ts";

const WIN_ENV = [
  "ALLUSERSPROFILE",
  "APPDATA",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "ComSpec",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PUBLIC",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "PATH",
  "Path",
  "windir",
];

const POSIX_ENV = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL", "TERM"];

/** Platform process env only. No secrets, no AEGIS_*, no NODE_OPTIONS. Not OS isolation. */
export function checkProcessEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const keys = process.platform === "win32" ? WIN_ENV : POSIX_ENV;
  const out: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  if (process.env.PATH && !out.PATH) out.PATH = process.env.PATH;
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

/** Kill the spawned process and its children. Windows uses taskkill /T, not POSIX killpg. */
export function killProcessTree(pid: number) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync(system32("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function runOwnedArgv(
  argv: string[],
  cwd: string,
  opts: { timeoutMs: number; abortSignal?: AbortSignal; env?: Record<string, string> },
) {
  return new Promise<{ exitCode: number; output: string; executed: boolean }>((resolve) => {
    const [command, ...args] = argv;
    if (!command) {
      resolve({ exitCode: 1, output: "empty argv", executed: false });
      return;
    }
    let started = false;
    let spawnFailed = false;
    let settled = false;
    let output = "";
    let program: string;
    try {
      program = programPath(command);
    } catch (error) {
      resolve({ exitCode: 127, output: error instanceof Error ? error.message : String(error), executed: false });
      return;
    }
    const child = spawn(program, args, {
      cwd,
      env: checkProcessEnv(opts.env),
      windowsHide: true,
    });
    const finish = (result: { exitCode: number; output: string; executed: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const stop = () => {
      if (child.pid) killProcessTree(child.pid);
    };
    const onAbort = () => stop();
    const timer = setTimeout(stop, opts.timeoutMs);
    if (opts.abortSignal?.aborted) {
      stop();
    } else {
      opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("spawn", () => {
      started = true;
      if (opts.abortSignal?.aborted) stop();
    });
    child.on("error", (error) => {
      spawnFailed = true;
      finish({ exitCode: 1, output: `${output}\n${error.message}`.trim(), executed: false });
    });
    child.on("close", (code) => {
      if (spawnFailed) return;
      const aborted = Boolean(opts.abortSignal?.aborted);
      finish({
        exitCode: aborted ? 1 : (code ?? 1),
        output: (aborted ? `${output}\ncancelled`.trim() : output).slice(0, 8000),
        executed: aborted ? false : started || code !== null,
      });
    });
  });
}
