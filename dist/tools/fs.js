import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { killProcessTree, ownGroup, releaseGroup } from "../exec.js";
import { findOnPath, windowsPowerShell } from "../which.js";
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
const MAX_SHELL_OUTPUT = 2_000_000;
/**
 * Run one PowerShell command. Its own process group on POSIX, so a timeout or stop ends everything it started
 * (taskkill /T on Windows). Resolves {stdout, stderr} on exit code 0; otherwise rejects with an error that
 * carries stdout, stderr, code and killed, like execFile's.
 */
export function runPowerShell(command, cwd, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
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
        let bytes = 0;
        let killed = false;
        let overflow = false;
        let settled = false;
        const killTree = () => {
            if (killed)
                return;
            killed = true;
            // Only while it runs: after exit its pid may already belong to something else (Windows recycles them fast).
            if (pid && child.exitCode === null && child.signalCode === null)
                killProcessTree(pid);
            // Something it started outside its group may still hold the pipes open: close them, so this always ends.
            child.stdout.destroy();
            child.stderr.destroy();
        };
        const timer = setTimeout(killTree, timeoutMs);
        const onAbort = () => killTree();
        if (signal?.aborted)
            killTree();
        else
            signal?.addEventListener("abort", onAbort, { once: true });
        const take = (chunk, into) => {
            if (overflow)
                return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_SHELL_OUTPUT) {
                overflow = true;
                killTree();
                return;
            }
            if (into === "out")
                stdout += chunk;
            else
                stderr += chunk;
        };
        // Decoded as text per stream, so a character split across two chunks is not garbled.
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => take(chunk, "out"));
        child.stderr.on("data", (chunk) => take(chunk, "err"));
        // Something it started may keep the pipes open after it exits: once it has exited and nothing has arrived for
        // a moment, settle anyway (the pipes are closed then). Output still flowing keeps it waiting.
        let exited;
        let idle;
        const armIdle = () => {
            if (!exited)
                return;
            clearTimeout(idle);
            idle = setTimeout(() => settleExit(exited.code, exited.signal), 500);
        };
        child.stdout.on("data", armIdle);
        child.stderr.on("data", armIdle);
        child.on("exit", (code, exitSignal) => {
            exited = { code, signal: exitSignal };
            armIdle();
        });
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(idle);
            signal?.removeEventListener("abort", onAbort);
            releaseGroup(pid);
            child.stdout.destroy();
            child.stderr.destroy();
            if (!error)
                resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
            else
                reject(Object.assign(error, { stdout, stderr }));
        };
        child.on("error", (error) => finish(Object.assign(error, { code: error.code })));
        const settleExit = (code, closeSignal) => {
            if (code === 0 && !killed)
                return finish(undefined);
            const why = signal?.aborted
                ? "stopped"
                : overflow
                    ? "output over 2 MB"
                    : killed
                        ? `timed out after ${timeoutMs} ms`
                        : code === null
                            ? `ended by ${closeSignal ?? "a signal"}`
                            : `exit code ${code}`;
            finish(Object.assign(new Error(`Command failed (${why}): ${command}`), {
                code: overflow ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : (code ?? closeSignal ?? "signal"),
                killed: killed && !overflow,
                signal: closeSignal ?? undefined,
            }));
        };
        child.on("close", (code, closeSignal) => settleExit(code, closeSignal));
        // Nothing is ever typed into the command: close stdin so PowerShell never waits on an open pipe.
        child.stdin.end();
    });
}
