import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { wrapLine } from "./tui-layout.ts";

export class ConfirmBox implements Component, Focusable {
  focused = false;
  private offset = 0;

  constructor(
    private readonly question: string,
    private readonly onAnswer: (ok: boolean) => void,
    private readonly rows = 24,
  ) {}

  handleInput(data: string) {
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
    if (data.includes("\x1b[200~") || data.includes("\n") || data.length > 1) return;
  }

  invalidate() {}

  render(width: number): string[] {
    const cols = Math.max(24, width);
    const wrapped = wrapLine(this.question, cols - 2).map((line) => ` ${line}`);
    const view = this.viewport();
    const maxOffset = Math.max(0, wrapped.length - view);
    this.offset = Math.min(this.offset, maxOffset);
    const slice = wrapped.slice(this.offset, this.offset + view);
    const marker = this.focused ? CURSOR_MARKER : "";
    const more =
      wrapped.length > view
        ? `  lines ${this.offset + 1}-${this.offset + slice.length} of ${wrapped.length}`
        : "";
    return [...slice, ` ${marker}[y/N]  Enter = No${more}`];
  }

  private viewport() {
    return Math.max(8, Math.min(this.rows - 6, Math.floor(this.rows * 0.7)));
  }
}
