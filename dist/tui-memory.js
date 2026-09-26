/** Fake terminal for automated TUI checks. Not a live Windows console. */
export class MemoryTerminal {
    columns = 80;
    rows = 24;
    kittyProtocolActive = false;
    writes = [];
    onInput;
    onResize;
    start(onInput, onResize) {
        this.onInput = onInput;
        this.onResize = onResize;
    }
    stop() { }
    async drainInput() { }
    write(data) {
        this.writes.push(data);
    }
    feed(data) {
        this.onInput?.(data);
    }
    resize(columns, rows) {
        this.columns = columns;
        this.rows = rows;
        this.onResize?.();
    }
    moveBy() { }
    hideCursor() { }
    showCursor() { }
    clearLine() { }
    clearFromCursor() { }
    clearScreen() { }
    setTitle() { }
    setProgress() { }
}
