import type { JevHealth } from "./types.ts";

export const ACCENT = "\x1b[36m";
export const MUTED = "\x1b[2m";
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
  const wrapAt = Math.max(8, cols - 5);
  return wrapLine(text, wrapAt).map((line, index) => (index === 0 ? `you  ${line}` : `     ${line}`));
}

export function renderAssistantMessage(text: string, cols: number): string[] {
  return wrapLine(text, Math.max(1, cols - 3)).map((line) => `  ${line}`);
}

export function renderSystemMessage(text: string, cols: number): string[] {
  return wrapLine(text, Math.max(1, cols - 3)).map((line) => `${MUTED}  ${line}${RESET}`);
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
}): string {
  const model = input.modelMode === "auto" ? "auto" : input.model;
  const task = `task ${input.task ?? "none"}`;
  if (input.busy) {
    const elapsed = Math.max(0, Math.floor((input.elapsedMs ?? 0) / 1000));
    const phase = input.phase ?? "working";
    return `${model} · jev ${input.jev} · ${task} · ${phase}  ${elapsed}s`;
  }
  return `${model} · jev ${input.jev} · ${input.provider} · ${task} · idle`;
}
