import { CURSOR_MARKER, Key, matchesKey } from "@earendil-works/pi-tui";
const ACCENT = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const INVERT = "\x1b[7m";
const RESET = "\x1b[0m";
/**
 * Every word of the query must appear in the id, group or note (case-insensitive).
 * Matches on the model id rank first (exact, then prefix, then anywhere), so typing "glm-5.3-flash"
 * picks that model, not "auto" whose note happens to mention it.
 */
export function filterItems(items, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length)
        return items;
    const q = words.join(" ");
    const rank = (item) => {
        const id = item.id.toLowerCase();
        if (id === q)
            return 0;
        if (id.startsWith(q))
            return 1;
        if (words.every((word) => id.includes(word)))
            return 2;
        return 3;
    };
    return items
        .filter((item) => {
        const hay = `${item.id} ${item.group} ${item.note}`.toLowerCase();
        return words.every((word) => hay.includes(word));
    })
        .map((item, order) => ({ item, order, score: rank(item) }))
        .sort((a, b) => a.score - b.score || a.order - b.order)
        .map((row) => row.item);
}
/**
 * The /model picker: type to filter, ↑↓ to move, Enter to pick, Esc to close.
 * Grouped by provider like the model menus in Cursor and Pi; "auto" (Jev picks each turn) is always first.
 */
export class ModelPicker {
    items;
    current;
    onDone;
    rows;
    focused = false;
    query = "";
    index = 0;
    constructor(items, current, onDone, rows = 24) {
        this.items = items;
        this.current = current;
        this.onDone = onDone;
        this.rows = rows;
        const at = items.findIndex((item) => item.id === current);
        this.index = Math.max(0, at);
    }
    visible() {
        return filterItems(this.items, this.query);
    }
    handleInput(data) {
        const list = this.visible();
        if (matchesKey(data, Key.escape))
            return this.onDone(undefined);
        if (matchesKey(data, Key.enter))
            return this.onDone(list[this.index]?.id);
        if (matchesKey(data, Key.up)) {
            this.index = Math.max(0, this.index - 1);
            return;
        }
        if (matchesKey(data, Key.down)) {
            this.index = Math.min(Math.max(0, list.length - 1), this.index + 1);
            return;
        }
        if (matchesKey(data, Key.pageUp)) {
            this.index = Math.max(0, this.index - this.viewport());
            return;
        }
        if (matchesKey(data, Key.pageDown)) {
            this.index = Math.min(Math.max(0, list.length - 1), this.index + this.viewport());
            return;
        }
        if (matchesKey(data, Key.backspace)) {
            this.query = this.query.slice(0, -1);
            this.index = 0;
            return;
        }
        // Printable characters (one at a time, or a paste) extend the filter.
        const text = data.replace(/\x1b\[200~|\x1b\[201~/g, "");
        if (text && !/[\x00-\x1f\x7f]/.test(text)) {
            this.query += text;
            this.index = 0;
        }
    }
    invalidate() { }
    viewport() {
        return Math.max(5, Math.min(14, this.rows - 10));
    }
    render(width) {
        const cols = Math.max(30, width);
        const list = this.visible();
        this.index = Math.min(this.index, Math.max(0, list.length - 1));
        const view = this.viewport();
        const start = Math.min(Math.max(0, this.index - Math.floor(view / 2)), Math.max(0, list.length - view));
        const lines = [
            ` ${BOLD}Pick a model${RESET}  ${DIM}current ${this.current || "auto"}${RESET}`,
            ` ${ACCENT}›${RESET} ${this.query}${this.focused ? CURSOR_MARKER : ""}${this.query ? "" : `${DIM}type to filter${RESET}`}`,
            "",
        ];
        let group = "";
        const idWidth = Math.min(28, Math.max(...list.map((item) => item.id.length), 8));
        for (let i = start; i < Math.min(list.length, start + view); i++) {
            const item = list[i];
            if (item.group !== group) {
                group = item.group;
                lines.push(` ${DIM}${group.toUpperCase()}${RESET}`);
            }
            const mark = item.id === this.current ? "●" : " ";
            const label = `${mark} ${item.id.padEnd(idWidth)}  ${item.note}`.slice(0, cols - 4);
            lines.push(i === this.index ? ` ${INVERT}${label}${RESET}` : ` ${label.replace(item.note, `${DIM}${item.note}${RESET}`)}`);
        }
        if (!list.length)
            lines.push(` ${DIM}No model matches "${this.query}"${RESET}`);
        lines.push("", ` ${DIM}↑↓ move · enter pick · esc close · ${list.length} of ${this.items.length}${RESET}`);
        return lines;
    }
}
