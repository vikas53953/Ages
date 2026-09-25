import { existsSync } from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
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
    if (process.env.AEGIS_POWERSHELL)
        return process.env.AEGIS_POWERSHELL;
    if (resolvedShell)
        return resolvedShell;
    const finder = process.platform === "win32" ? "where" : "which";
    const found = spawnSync(finder, ["pwsh"], { stdio: "ignore", windowsHide: true }).status === 0;
    resolvedShell = found ? (process.platform === "win32" ? "pwsh.exe" : "pwsh") : "powershell.exe";
    return resolvedShell;
}
export async function runPowerShell(command, cwd, timeoutMs, signal) {
    const { stdout, stderr } = await execFileAsync(powershellExe(), ["-NoProfile", "-NonInteractive", "-Command", command], { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 2_000_000, signal });
    return {
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
    };
}
