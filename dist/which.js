/**
 * Find programs without looking in the project folder.
 *
 * On Windows, starting "git" or "powershell.exe" by bare name makes libuv (and cmd.exe) look in the child's
 * working folder before PATH, so a cloned repo that ships its own git.exe would run instead of yours. Aegis
 * therefore resolves every program itself: Windows tools from System32 by full path, everything else from the
 * absolute folders on PATH only ("." and relative entries are skipped), and spawns the full path.
 */
import { statSync } from "node:fs";
import path from "node:path";
function isFile(file) {
    try {
        return statSync(file).isFile();
    }
    catch {
        return false;
    }
}
/** The full path of `name` found on PATH (absolute entries only), or undefined. A name with a folder is returned as is. */
export function findOnPath(name, env = process.env) {
    if (!name)
        return undefined;
    if (name.includes("/") || name.includes("\\"))
        return isFile(name) ? path.resolve(name) : undefined;
    const pathVar = env.PATH ?? env.Path ?? "";
    const dirs = pathVar.split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir));
    const win = process.platform === "win32";
    const exts = win ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
    const hasExt = win && exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
    for (const dir of dirs) {
        if (hasExt || !win) {
            const file = path.join(dir, name);
            if (isFile(file))
                return file;
            if (!win)
                continue;
        }
        for (const ext of exts) {
            const file = path.join(dir, name + ext.toLowerCase());
            if (isFile(file))
                return file;
        }
    }
    return undefined;
}
/** A program to spawn: the full path when found, else the name (the spawn then fails with "not found"). */
export function programPath(name) {
    return findOnPath(name) ?? name;
}
/** A Windows tool from System32 by full path (taskkill, icacls, rundll32, where). */
export function system32(name) {
    return path.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", name);
}
/** Windows PowerShell 5.1 by full path. */
export function windowsPowerShell() {
    return path.join(system32("WindowsPowerShell"), "v1.0", "powershell.exe");
}
/** For cmd.exe shims (.cmd/.bat): tells cmd not to look in the current folder for programs. */
export const NO_CWD_SEARCH_ENV = { NoDefaultCurrentDirectoryInExePath: "1" };
