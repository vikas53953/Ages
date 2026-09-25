import { spawn } from "node:child_process";
/**
 * Put text on the clipboard. Windows: PowerShell reads it from stdin as UTF-8 (clip.exe and the default console
 * encoding mangle non-ASCII text). macOS: pbcopy. Linux: wl-copy or xclip. Resolves false when none works.
 * Async, so a slow PowerShell start does not freeze the screen.
 */
export async function copyToClipboard(text) {
    const attempts = process.platform === "win32"
        ? [
            [
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
            ],
        ]
        : process.platform === "darwin"
            ? [["pbcopy", []]]
            : [
                ["wl-copy", []],
                ["xclip", ["-selection", "clipboard"]],
            ];
    for (const [command, args] of attempts) {
        if (await runWithInput(command, args, text))
            return true;
    }
    return false;
}
function runWithInput(command, args, input) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"], timeout: 10_000 });
        }
        catch {
            resolve(false);
            return;
        }
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
    });
}
