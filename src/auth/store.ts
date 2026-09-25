/**
 * Subscription sign-ins (ChatGPT, …) saved in ~/.aegis/auth.json, one entry per provider.
 * The file is written atomically and locked to your Windows account (icacls), or mode 600 elsewhere.
 * API keys stay in ~/.aegis/.env as before.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userAegisDir } from "../env.ts";

export type OAuthCredential = {
  access: string;
  refresh: string;
  /** Epoch milliseconds when `access` stops working. */
  expires: number;
  accountId?: string;
  email?: string;
};

export function authFile() {
  return path.join(userAegisDir(), "auth.json");
}

function readAll(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(authFile(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadCredential(name: string): OAuthCredential | undefined {
  const entry = readAll()[name] as Partial<OAuthCredential> | undefined;
  if (!entry || typeof entry.access !== "string" || typeof entry.refresh !== "string" || typeof entry.expires !== "number") {
    return undefined;
  }
  return entry as OAuthCredential;
}

/** Save (or with undefined, remove) one provider's sign-in. */
export function saveCredential(name: string, credential: OAuthCredential | undefined) {
  const all = readAll();
  if (credential) all[name] = credential;
  else delete all[name];
  const file = authFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
  lockToUser(file);
  return file;
}

/** Only you can read it: mode 600 on Linux/macOS; on Windows drop inherited access and grant just your account. */
export function lockToUser(file: string) {
  if (process.platform !== "win32") {
    try {
      chmodSync(file, 0o600);
    } catch {
      // best effort
    }
    return;
  }
  const user = process.env.USERNAME;
  if (!user) return;
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${account}:F`], { stdio: "ignore", windowsHide: true });
}
