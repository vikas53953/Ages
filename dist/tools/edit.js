import { readFile } from "node:fs/promises";
import { assertInsideCwd, writeFileInsideCwd } from "../env.js";
/** 1-based line numbers where `needle` starts in `body` (at most 10). */
function lineNumbers(body, needle) {
    const lines = [];
    let at = body.indexOf(needle);
    while (at >= 0 && lines.length < 10) {
        lines.push(body.slice(0, at).split("\n").length);
        at = body.indexOf(needle, at + needle.length);
    }
    return lines;
}
/**
 * Replace old_string with new_string: exactly one match, or every match with replaceAll (like Claude Code's
 * Edit). A file with Windows line endings (CRLF) is matched with the model's "\n" text turned into "\r\n", and
 * the replacement keeps the file's line endings.
 */
export async function editPath(relativePath, oldString, newString, cwd, options = {}) {
    if (!oldString)
        throw new Error("old_string is empty");
    if (oldString === newString)
        throw new Error("old_string and new_string are the same; nothing to change");
    const target = await assertInsideCwd(relativePath, cwd);
    const body = await readFile(target, "utf8");
    let find = oldString;
    let replace = newString;
    if (!body.includes(find) && body.includes("\r\n") && !find.includes("\r\n") && find.includes("\n")) {
        find = find.replace(/\n/g, "\r\n");
        replace = replace.replace(/\r?\n/g, "\r\n");
    }
    const count = body.split(find).length - 1;
    if (count === 0)
        throw new Error(`old_string not found in ${relativePath}. Read the file again and copy the text exactly.`);
    if (count > 1 && !options.replaceAll) {
        throw new Error(`old_string is not unique in ${relativePath} (${count} matches, at lines ${lineNumbers(body, find).join(", ")}). Add surrounding lines to make it unique, or set replace_all.`);
    }
    const next = options.replaceAll ? body.split(find).join(replace) : body.replace(find, () => replace);
    await writeFileInsideCwd(relativePath, next, cwd);
    return count > 1 ? `edited ${relativePath} (${count} places)` : `edited ${relativePath}`;
}
