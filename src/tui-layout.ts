import { formatTokenLine } from "./receipt.ts";
import { on, paint } from "./theme.ts";
import type { JevHealth } from "./types.ts";

export const RESET = "\x1b[0m";

export function stripAnsi(text: string) {
  return sanitizeText(text);
}

export function sanitizeText(text: string) {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[_P^][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[\?\d;]*[ -/]*[@-~]/g, "")
    .replace(/\x1b./g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function wrapLine(text: string, width: number): string[] {
  const cols = Math.max(1, width);
  const source = sanitizeText(text).replace(/\t/g, "  ").split(/\r?\n/);
  const out: string[] = [];
  for (const raw of source) {
    if (!raw) {
      out.push("");
      continue;
    }
    for (let i = 0; i < raw.length; i += cols) {
      out.push(raw.slice(i, i + cols));
    }
  }
  return out.length ? out : [""];
}

export function welcomeBanner(input: {
  name: string;
  version: string;
  tagline?: string;
  difference?: string;
}): string {
  return [
    `${input.name}  v${input.version}`,
    `${input.tagline ?? "the agent you own"}. ${input.difference ?? "Jev locks spend and danger."}`,
  ].join("\n");
}

export function renderUserMessage(text: string, cols: number): string[] {
  const wrapAt = Math.max(8, cols - 3);
  return wrapLine(text, wrapAt).map((line, index) => (index === 0 ? `${on("accent")}›${RESET} ${line}` : `  ${line}`));
}

export type ToolStatus = "pending" | "ran" | "denied";

const DOT_ROLE: Record<ToolStatus, "warn" | "ok" | "err"> = { pending: "warn", ran: "ok", denied: "err" };
const dot = (status: ToolStatus) => paint(DOT_ROLE[status], "●");

/** "● read README.md   rule read *" — one line per tool call, dot coloured by what happened. */
export function renderToolLine(item: { text: string; status: ToolStatus; detail?: string }, cols: number): string[] {
  const head = `${dot(item.status)} ${item.text}`;
  const detail = item.detail ? `${on("dim")}${item.detail}${RESET}` : "";
  const lines = wrapLine(item.text, Math.max(8, cols - 4)).map((line, index) =>
    index === 0 ? `${dot(item.status)} ${line}` : `  ${line}`,
  );
  if (!detail) return lines.length ? lines : [head];
  return [...lines, ...wrapLine(item.detail!, Math.max(8, cols - 6)).map((line) => `  ${on("dim")}└ ${line}${RESET}`)];
}

export function renderAssistantMessage(text: string, cols: number): string[] {
  return wrapLine(text, Math.max(1, cols - 3)).map((line) => `  ${line}`);
}

export function renderSystemMessage(text: string, cols: number): string[] {
  return wrapLine(text, Math.max(1, cols - 3)).map((line) => `${on("dim")}  ${line}${RESET}`);
}

export function jevStatus(mockJev: boolean, hasKey: boolean, healthy?: boolean): "mock" | "live" | "down" | "blocked" {
  if (mockJev) return "mock";
  if (!hasKey) return "blocked";
  return healthy ? "live" : "down";
}

export function footerText(input: {
  modelMode: "auto" | "pinned";
  model: string;
  jev: JevHealth;
  provider: string;
  busy?: boolean;
  phase?: string;
  elapsedMs?: number;
  task?: string;
  /** Short working folder, shown first like Pi's footer. */
  cwd?: string;
  /** Git branch of the folder, shown after it: "~/app (main)". */
  branch?: string;
  /** Thinking level, e.g. "low". */
  think?: string;
  /** Session token total, e.g. "↑ 12k ↓ 830". */
  tokens?: string;
  /** Plan mode is on: read-only until you approve. */
  plan?: boolean;
  /** Conversation size as a % of the auto-compaction limit. */
  context?: number;
}): string {
  const model = `${input.plan ? "PLAN · " : ""}${input.modelMode === "auto" ? "auto" : input.model}`;
  const task = `task ${input.task ?? "none"}`;
  const place = input.cwd ? `${input.cwd}${input.branch ? ` (${input.branch})` : ""} · ` : "";
  const extra = `${input.think ? ` · think ${input.think}` : ""}${input.tokens ? ` · ${input.tokens}` : ""}${input.context !== undefined ? ` · ctx ${input.context}%` : ""}`;
  if (input.busy) {
    const elapsed = Math.max(0, Math.floor((input.elapsedMs ?? 0) / 1000));
    const phase = input.phase ?? "working";
    // While busy, what is happening comes first so a narrow terminal never cuts it off.
    return `${phase}  ${elapsed}s · ${place}${model} · jev ${input.jev}${extra} · ${task}`;
  }
  return `${place}${model} · jev ${input.jev} · ${input.provider}${extra} · ${task} · idle`;
}

/** One compact line after each turn, in place of the full handoff card the REPL prints. */
export function turnStatusLines(receipt: {
  outcome?: string;
  tools: { name: string; approved: boolean; target?: string; deniedReason?: string }[];
  ms: number;
  model: string;
  text: string;
  finishReason?: string;
  steps?: number;
  taskId?: string;
  tokens?: { input: number; output: number; reasoning?: number };
}): string[] {
  const seconds = `${(receipt.ms / 1000).toFixed(1)}s`;
  const tokenText = formatTokenLine(receipt.tokens);
  const tokenPart = tokenText ? ` · ${tokenText}` : "";
  const tools = receipt.tools.length ? `${receipt.tools.length} tool${receipt.tools.length === 1 ? "" : "s"}` : "no tools";
  const changed = receipt.tools
    .filter((tool) => tool.approved && (tool.name === "write" || tool.name === "edit"))
    .map((tool) => tool.target ?? tool.name);
  const outcome = receipt.outcome ?? "completed";
  const head =
    outcome === "completed"
      ? `✓ done · ${tools}${tokenPart} · ${seconds} · ${receipt.model}`
      : outcome === "blocked"
        ? `⚠ blocked · ${tools}${tokenPart} · ${seconds}`
        : outcome === "cancelled"
          ? `✗ cancelled · ${seconds}`
          : `… incomplete · finish=${receipt.finishReason ?? "?"} · ${receipt.steps ?? 0} steps · ${seconds}`;
  const lines = [head];
  if (changed.length) lines.push(`changed ${[...new Set(changed)].join(", ")}`);
  const blocked = /^Blocked {2}(.*)$/m.exec(receipt.text)?.[1];
  if (blocked) lines.push(`blocked ${blocked}`);
  const next = /^Next {2}(.*)$/m.exec(receipt.text)?.[1];
  if (next && (outcome !== "completed" || receipt.taskId)) lines.push(`next    ${next}`);
  return lines;
}

/** Reasoning in the transcript: folded to one line (default), shown in full, or not at all. */
export function renderThinking(
  item: { text: string; startedAt: number; endedAt?: number },
  display: "fold" | "show" | "hide",
  cols: number,
): string[] {
  if (display === "hide") return [];
  const seconds = Math.max(1, Math.round(((item.endedAt ?? Date.now()) - item.startedAt) / 1000));
  const head = item.endedAt ? `Thought for ${seconds}s` : `Thinking… ${seconds}s`;
  if (display === "fold") return [`${on("dim")}▸ ${head} · ctrl+t to open${RESET}`];
  const body = wrapLine(item.text.trim(), Math.max(8, cols - 4)).map((line) => `${on("dim")}${on("italic")}  ${line}${RESET}`);
  return [`${on("dim")}▾ ${head} · ctrl+t to fold${RESET}`, ...body];
}
