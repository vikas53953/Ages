import type { Terminal } from "@earendil-works/pi-tui";

/** Fake terminal for automated TUI checks. Not a live Windows console. */
export class MemoryTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  writes: string[] = [];
  private onInput?: (data: string) => void;
  private onResize?: () => void;

  start(onInput: (data: string) => void, onResize: () => void) {
    this.onInput = onInput;
    this.onResize = onResize;
  }

  stop() {}

  async drainInput() {}

  write(data: string) {
    this.writes.push(data);
  }

  feed(data: string) {
    this.onInput?.(data);
  }

  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.onResize?.();
  }

  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}
