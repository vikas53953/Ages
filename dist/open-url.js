import { spawn } from "node:child_process";
import { system32 } from "./which.js";
/**
 * Open an http(s) link in the default browser. No shell parses the URL: on Windows `cmd /c start` would
 * split a sign-in URL at every "&". Set AEGIS_NO_BROWSER=1 to only print links.
 */
export function openUrl(url, onFail = () => { }) {
    if (!/^https?:\/\//i.test(url) || process.env.AEGIS_NO_BROWSER === "1")
        return false;
    const [cmd, args] = process.platform === "win32"
        ? [system32("rundll32.exe"), ["url.dll,FileProtocolHandler", url]]
        : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];
    try {
        const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
        child.on("error", onFail);
        child.unref();
        return true;
    }
    catch {
        onFail();
        return false;
    }
}
