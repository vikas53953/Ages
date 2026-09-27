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
/** One replacement on text in memory; `label` names it in errors ("edit 2"). Returns the new text and how many places. */
function applyEdit(body, edit, relativePath, label = "old_string") {
    const { old_string: oldString, new_string: newString } = edit;
    if (!oldString)
        throw new Error(`${label}: old_string is empty`);
    if (oldString === newString)
        throw new Error(`${label}: old_string and new_string are the same; nothing to change`);
    let find = oldString;
    let replace = newString;
    if (!body.includes(find) && body.includes("\r\n") && !find.includes("\r\n") && find.includes("\n")) {
        find = find.replace(/\n/g, "\r\n");
        replace = replace.replace(/\r?\n/g, "\r\n");
    }
    const count = body.split(find).length - 1;
    if (count === 0)
        throw new Error(`${label}: old_string not found in ${relativePath}. Read the file again and copy the text exactly.`);
    if (count > 1 && !edit.replace_all) {
        throw new Error(`${label}: old_string is not unique in ${relativePath} (${count} matches, at lines ${lineNumbers(body, find).join(", ")}). Add surrounding lines to make it unique, or set replace_all.`);
    }
    return { body: edit.replace_all ? body.split(find).join(replace) : body.replace(find, () => replace), count };
}
/**
 * Several replacements in one file, in order, each on the result of the one before (like Claude Code's
 * MultiEdit). All or nothing: if one does not apply, the file is not touched and the error names which.
 */
export async function multiEditPath(relativePath, edits, cwd) {
    if (!edits.length)
        throw new Error("edits is empty");
    if (edits.length > 50)
        throw new Error("at most 50 edits at once");
    const target = await assertInsideCwd(relativePath, cwd);
    let body = await readFile(target, "utf8");
    let places = 0;
    edits.forEach((edit, index) => {
        const next = applyEdit(body, edit, relativePath, `edit ${index + 1}`);
        body = next.body;
        places += next.count;
    });
    await writeFileInsideCwd(relativePath, body, cwd);
    return `edited ${relativePath} (${edits.length} edits, ${places} places)`;
}
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
