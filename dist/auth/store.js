/**
 * Subscription sign-ins (ChatGPT, …) saved in ~/.aegis/auth.json, one entry per provider.
 * The file is written atomically and locked to your Windows account (icacls), or mode 600 elsewhere.
 * API keys stay in ~/.aegis/.env as before.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { userAegisDir } from "../env.js";
export function authFile() {
    return path.join(userAegisDir(), "auth.json");
}
function readAll() {
    try {
        const parsed = JSON.parse(readFileSync(authFile(), "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
export function loadCredential(name) {
    const entry = readAll()[name];
    if (!entry || typeof entry.access !== "string" || typeof entry.refresh !== "string" || typeof entry.expires !== "number") {
        return undefined;
    }
    return entry;
}
/** Save (or with undefined, remove) one provider's sign-in. */
export function saveCredential(name, credential) {
    const all = readAll();
    if (credential)
        all[name] = credential;
    else
        delete all[name];
    const file = authFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
    lockToUser(file);
    return file;
}
/** Only you can read it: mode 600 on Linux/macOS; on Windows drop inherited access and grant just your account. */
function lockToUser(file) {
    if (process.platform !== "win32") {
        try {
            chmodSync(file, 0o600);
        }
        catch {
            // best effort
        }
        return;
    }
    const user = process.env.USERNAME;
    if (!user)
        return;
    const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
    spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${account}:F`], { stdio: "ignore", windowsHide: true });
}
