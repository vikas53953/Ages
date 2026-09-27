import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { ConfirmCard } from "./confirm-card.ts";
import { on, paint } from "./theme.ts";
import { RESET, sanitizeText, wrapLine } from "./tui-layout.ts";
import type { ConfirmAnswer } from "./types.ts";

type Choice = { label: string; hint?: string; answer: ConfirmAnswer };

/** Lines of the file shown before "ctrl+o to see all" (fewer on a short terminal, so the choices always fit). */
const PREVIEW_LINES = 12;

/**
 * The question before a tool runs. With a card it looks like Claude Code's: a box, the file in a frame, the
 * question, and numbered choices (arrows + Enter, or 1 / 2 / 3; y, a, n and esc work too). The highlight starts
 * on No, so Enter alone never says yes. Without a card (older callers) it shows the question text.
 */
export class ConfirmBox implements Component, Focusable {
  focused = false;
  private offset = 0;
  private selected: number;
  private expanded = false;
  private readonly choices: Choice[];

  constructor(
    private readonly question: string,
    private readonly onAnswer: (ok: ConfirmAnswer) => void,
    private readonly rows = 24,
    /** The allow rule "a" would save; without it only yes / no are offered. */
    private readonly always?: string,
    private readonly card?: ConfirmCard,
  ) {
    this.choices = [
      { label: "Yes", answer: true },
      ...(always ? [{ label: `Yes, and don't ask again for: ${always}`, answer: "always" as const }] : []),
      { label: "No, and tell Aegis what to do instead", hint: "esc", answer: false },
    ];
    this.selected = this.choices.length - 1;
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.ctrl("o"))) {
      this.expanded = !this.expanded;
      this.offset = 0;
      return;
    }
    const scroll = (by: number) => {
      this.expanded = true;
      this.offset = Math.max(0, this.offset + by);
    };
    if (matchesKey(data, Key.up)) {
      if (this.card) this.selected = Math.max(0, this.selected - 1);
      else this.offset = Math.max(0, this.offset - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.card) this.selected = Math.min(this.choices.length - 1, this.selected + 1);
      else this.offset += 1;
      return;
    }
    if (matchesKey(data, Key.pageUp)) return scroll(-this.viewport());
    if (matchesKey(data, Key.pageDown)) return scroll(this.viewport());
    if (matchesKey(data, Key.home)) {
      this.offset = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.offset = Number.MAX_SAFE_INTEGER;
      return;
    }
    if (matchesKey(data, Key.escape) || /^n$/i.test(data)) return this.onAnswer(false);
    if (matchesKey(data, Key.enter)) return this.onAnswer(this.card ? this.choices[this.selected]!.answer : false);
    if (/^y$/i.test(data)) return this.onAnswer(true);
    if (this.always && /^a$/i.test(data)) return this.onAnswer("always");
    if (this.card && /^[1-9]$/.test(data)) {
      const choice = this.choices[Number(data) - 1];
      if (choice) this.onAnswer(choice.answer);
      return;
    }
  }

  invalidate() {}

  render(width: number): string[] {
    return this.card ? this.renderCard(this.card, Math.max(30, width)) : this.renderText(Math.max(24, width));
  }

  /** Room for the file: the card's other lines (about 11) and the overlay's margins come first. */
  private viewport() {
    return Math.max(3, Math.floor(this.rows * 0.8) - 12);
  }

  private renderCard(card: ConfirmCard, cols: number): string[] {
    const inner = cols - 4;
    const dim = (text: string) => `${on("dim")}${text}${RESET}`;
    const row = (text: string) => `${dim("│")} ${truncateToWidth(text, inner, "…", true)} ${dim("│")}`;
    const out = [dim(`╭${"─".repeat(cols - 2)}╮`), row(`\x1b[1m${card.title}${RESET}`)];

    if (card.subject || card.lines.length) {
      const frame = inner - 4;
      const framed = (text: string) => `${dim("│")} ${truncateToWidth(text, frame, "…", true)} ${dim("│")}`;
      out.push(row(dim(`╭${"─".repeat(inner - 2)}╮`)));
      if (card.subject) out.push(row(framed(clean(card.subject))));
      const room = this.expanded ? this.viewport() : Math.min(PREVIEW_LINES, this.viewport());
      this.offset = Math.min(this.offset, Math.max(0, card.lines.length - room));
      const start = this.expanded ? this.offset : 0;
      const shown = card.lines.slice(start, start + room);
      const numbers = String(card.lines.length).length;
      shown.forEach((line, index) => out.push(row(framed(paintLine(card.kind, clean(line), start + index + 1, numbers)))));
      const hidden = card.lines.length - shown.length;
      if (this.expanded && card.lines.length > room) {
        out.push(row(framed(dim(`lines ${start + 1}-${start + shown.length} of ${card.lines.length} · PgUp/PgDn to scroll · ctrl+o to fold`))));
      } else if (hidden > 0) {
        out.push(row(framed(dim(`… +${hidden} lines (ctrl+o to see all)`))));
      }
      out.push(row(dim(`╰${"─".repeat(inner - 2)}╯`)));
    }

    out.push(row(`${card.question}${card.facts ? `  ${dim(card.facts)}` : ""}`));
    this.choices.forEach((choice, index) => {
      const text = `${index + 1}. ${choice.label}${choice.hint ? ` ${dim(`(${choice.hint})`)}` : ""}`;
      const chosen = index === this.selected;
      const marker = chosen && this.focused ? CURSOR_MARKER : "";
      out.push(row(chosen ? `${marker}${paint("accent", `❯ ${text}`)}` : `  ${text}`));
    });
    out.push(row(dim(card.reason)));
    out.push(dim(`╰${"─".repeat(cols - 2)}╯`));
    return out;
  }

  private renderText(cols: number): string[] {
    const wrapped = wrapLine(this.question, cols - 2).map((line) => ` ${line}`);
    const view = Math.max(8, Math.min(this.rows - 6, Math.floor(this.rows * 0.7)));
    const maxOffset = Math.max(0, wrapped.length - view);
    this.offset = Math.min(this.offset, maxOffset);
    const slice = wrapped.slice(this.offset, this.offset + view);
    const marker = this.focused ? CURSOR_MARKER : "";
    const more = wrapped.length > view ? `  lines ${this.offset + 1}-${this.offset + slice.length} of ${wrapped.length}` : "";
    const keys = this.always ? `[y] yes  [a] always allow: ${this.always}  [N] no  Enter = No` : "[y/N]  Enter = No";
    return [...slice, ` ${marker}${keys}${more}`];
  }
}

/** Text the model wrote, safe to draw: no escape codes (it cannot paint fake lines or colours), tabs as spaces. */
function clean(text: string) {
  return sanitizeText(text).replace(/\t/g, "  ");
}

function paintLine(kind: ConfirmCard["kind"], line: string, number: number, width: number) {
  if (kind === "code") return `${paint("dim", String(number).padStart(width))} ${line}`;
  if (kind === "diff") {
    if (line.startsWith("+ ")) return paint("ok", line);
    if (line.startsWith("- ")) return paint("err", line);
    if (/^@@|^change \d+ of \d+$/.test(line)) return paint("dim", line);
  }
  return line;
}
