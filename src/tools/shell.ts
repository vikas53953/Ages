import { loadConfig } from "../config.ts";
import { runPowerShell } from "./fs.ts";

export function shellAllowed() {
  return process.env.AEGIS_ALLOW_SHELL === "1";
}

export async function runShell(command: string, cwd: string, signal?: AbortSignal) {
  if (!shellAllowed()) {
    throw new Error(
      "Shell is disabled. PowerShell is not confined to the working folder. Set AEGIS_ALLOW_SHELL=1 to override.",
    );
  }
  const config = loadConfig(cwd);
  return runPowerShell(command, cwd, config.shellTimeoutMs, signal);
}
