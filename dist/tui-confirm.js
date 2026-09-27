import { CURSOR_MARKER, Key, matchesKey, } from "@earendil-works/pi-tui";
import { wrapLine } from "./tui-layout.js";
export class ConfirmBox {
    question;
    onAnswer;
    rows;
    always;
    focused = false;
    offset = 0;
    constructor(question, onAnswer, rows = 24, 
    /** The allow rule "a" would save; without it only y / N are offered. */
    always) {
        this.question = question;
        this.onAnswer = onAnswer;
        this.rows = rows;
        this.always = always;
    }
    handleInput(data) {
        if (matchesKey(data, Key.up)) {
            this.offset = Math.max(0, this.offset - 1);
            return;
        }
        if (matchesKey(data, Key.down)) {
            this.offset += 1;
            return;
        }
        if (matchesKey(data, Key.pageUp)) {
            this.offset = Math.max(0, this.offset - this.viewport());
            return;
        }
        if (matchesKey(data, Key.pageDown)) {
            this.offset += this.viewport();
            return;
        }
        if (matchesKey(data, Key.home)) {
            this.offset = 0;
            return;
        }
        if (matchesKey(data, Key.end)) {
            this.offset = Number.MAX_SAFE_INTEGER;
            return;
        }
        if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || /^n$/i.test(data)) {
            this.onAnswer(false);
            return;
        }
        if (/^y$/i.test(data)) {
            this.onAnswer(true);
            return;
        }
        if (this.always && /^a$/i.test(data)) {
            this.onAnswer("always");
            return;
        }
        if (data.includes("\x1b[200~") || data.includes("\n") || data.length > 1)
            return;
    }
    invalidate() { }
    render(width) {
        const cols = Math.max(24, width);
        const wrapped = wrapLine(this.question, cols - 2).map((line) => ` ${line}`);
        const view = this.viewport();
        const maxOffset = Math.max(0, wrapped.length - view);
        this.offset = Math.min(this.offset, maxOffset);
        const slice = wrapped.slice(this.offset, this.offset + view);
        const marker = this.focused ? CURSOR_MARKER : "";
        const more = wrapped.length > view
            ? `  lines ${this.offset + 1}-${this.offset + slice.length} of ${wrapped.length}`
            : "";
        const keys = this.always
            ? `[y] yes  [a] always allow: ${this.always}  [N] no  Enter = No`
            : "[y/N]  Enter = No";
        return [...slice, ` ${marker}${keys}${more}`];
    }
    viewport() {
        return Math.max(8, Math.min(this.rows - 6, Math.floor(this.rows * 0.7)));
    }
}
