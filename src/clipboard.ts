import { spawnSync } from "node:child_process";

/**
 * Put text on the clipboard. Windows: PowerShell reads it from stdin as UTF-8 (clip.exe and the default console
 * encoding mangle non-ASCII text). macOS: pbcopy. Linux: wl-copy or xclip. Returns false when none works.
 */
export function copyToClipboard(text: string) {
  const attempts: Array<[string, string[]]> =
    process.platform === "win32"
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
    const run = spawnSync(command, args, { input: text, windowsHide: true, timeout: 10_000 });
    if (run.status === 0) return true;
  }
  return false;
}
