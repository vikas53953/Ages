/**
 * The model's todo list for multi-step work (Claude Code's TodoWrite, OpenCode's todowrite, Codex's update_plan).
 * Each `todo` call replaces the whole list. The list lives in the conversation itself (the last todo call), so
 * /rewind and /resume show the right one without extra state. It touches nothing outside the chat, so it never
 * asks you or Jev; a deny rule (`deny todo`) still turns it off.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export const MAX_TODOS = 30;
const MAX_TEXT = 200;
const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);
/** Keep the list small and plain: no control characters or terminal escape codes from the model. */
export function cleanTodos(value) {
    const rows = Array.isArray(value) ? value : [];
    const out = [];
    for (const row of rows.slice(0, MAX_TODOS)) {
        const item = row;
        const content = String(item?.content ?? "")
            // eslint-disable-next-line no-control-regex
            .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
            // eslint-disable-next-line no-control-regex
            .replace(/[\x00-\x1f\x7f]/g, " ")
            .trim()
            .slice(0, MAX_TEXT);
        if (!content)
            continue;
        const status = STATUSES.has(item?.status) ? item.status : "pending";
        out.push({ content, status });
    }
    return out;
}
/** What the tool answers the model with. */
export function todoSummary(todos) {
    const open = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length;
    const doing = todos.find((todo) => todo.status === "in_progress");
    return `${todos.length} item(s), ${open} open${doing ? `; now: ${doing.content}` : ""}`;
}
/** Lines for the TUI box above the editor: nothing once every item is done. */
export function todoLines(todos, max = 5) {
    if (!todos.length || todos.every((todo) => todo.status === "completed" || todo.status === "cancelled"))
        return [];
    const mark = { pending: "[ ]", in_progress: "[>]", completed: "[x]", cancelled: "[-]" };
    // Show what is being done and what is next first; finished items fill the rest.
    const order = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 };
    const shown = [...todos].map((todo, index) => ({ todo, index })).sort((a, b) => order[a.todo.status] - order[b.todo.status] || a.index - b.index);
    const lines = shown.slice(0, max).sort((a, b) => a.index - b.index).map(({ todo }) => `${mark[todo.status]} ${todo.content}`);
    if (todos.length > max)
        lines.push(`    … ${todos.length - max} more (/todos)`);
    return lines;
}
/** The list is also kept next to the session, so compaction (which drops old turns) cannot lose it. */
export function todosFile(sessionDirectory) {
    return path.join(sessionDirectory, "todos.json");
}
export async function saveTodos(sessionDirectory, todos) {
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(todosFile(sessionDirectory), `${JSON.stringify(cleanTodos(todos))}\n`);
}
export async function loadSavedTodos(sessionDirectory) {
    try {
        return cleanTodos(JSON.parse(await readFile(todosFile(sessionDirectory), "utf8")));
    }
    catch {
        return undefined;
    }
}
/** The latest list in a saved conversation (the input of the last todo tool call). */
export function todosFromMessages(rows) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row.role !== "assistant" || typeof row.content === "string")
            continue;
        for (let j = row.content.length - 1; j >= 0; j -= 1) {
            const part = row.content[j];
            if (part.type === "tool-call" && part.toolName === "todo")
                return cleanTodos(part.input?.todos);
        }
    }
    return [];
}
export const TODO_TOOL_DESCRIPTION = [
    "Keep a short todo list for work with 3 or more steps, or when the user gives several tasks.",
    "Send the whole list every time. Exactly one item in_progress while working; mark items completed as soon as they are done.",
    "Skip it for single, simple tasks. Statuses: pending, in_progress, completed, cancelled.",
].join(" ");
