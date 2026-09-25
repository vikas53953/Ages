import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { killProcessTree, ownGroup, releaseGroup } from "../exec.js";
import { findOnPath, windowsPowerShell } from "../which.js";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export function isGitRepo(cwd) {
    return existsSync(path.join(cwd, ".git"));
}
let resolvedShell;
/**
 * Which PowerShell to run. Like Pi: PowerShell 7 (pwsh) when installed, otherwise Windows PowerShell 5.1.
 * AEGIS_POWERSHELL overrides it.
 */
export function powershellExe() {
    const override = process.env.AEGIS_POWERSHELL;
    // A bare name is looked up on PATH like everything else (never in the project folder).
    if (override)
        return path.isAbsolute(override) ? override : (findOnPath(override) ?? windowsPowerShell());
    if (resolvedShell)
        return resolvedShell;
    // Full paths only: a bare name would let a pwsh.exe in the project folder run instead (see which.ts).
    resolvedShell = findOnPath("pwsh") ?? (process.platform === "win32" ? windowsPowerShell() : "pwsh");
    return resolvedShell;
}
export async function runPowerShell(command, cwd, timeoutMs, signal) {
    const running = execFileAsync(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", command], 
    // POSIX: its own process group, so a timeout or stop also ends what the command started.
    { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 2_000_000, signal, ...{ detached: process.platform !== "win32" } });
    const pid = running.child.pid;
    ownGroup(pid);
    // execFile's timeout and stop end PowerShell itself; this ends everything it started (taskkill /T, or the group).
    const killTree = () => {
        if (pid)
            killProcessTree(pid);
    };
    const timer = setTimeout(killTree, timeoutMs);
    signal?.addEventListener("abort", killTree, { once: true });
    // Nothing is ever typed into the command: close stdin so PowerShell never waits on an open pipe.
    running.child.stdin?.end();
    try {
        const { stdout, stderr } = await running;
        return {
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
        };
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", killTree);
        releaseGroup(pid);
    }
}
