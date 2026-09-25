import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { Receipt, ToolRecord, TurnOutcome } from "./types.ts";

export function millicentsFromUsage(_inputTokens: number, _outputTokens: number) {
  return 0;
}

export function formatTurnHandoff(input: {
  modelText: string;
  outcome: TurnOutcome;
  tools: ToolRecord[];
  block?: string;
  finishReason?: string;
  steps?: number;
  changed: string[];
  checks: string[];
  next: string;
  taskId?: string;
  taskFingerprint?: string;
}) {
  const model = input.modelText.replace(/^\(no text\)\s*$/i, "").trim();
  const denied = input.tools.filter((tool) => !tool.approved && tool.deniedReason);
  const lines = [
    `Outcome  ${input.outcome}`,
    input.taskId
      ? `Task  ${input.taskId}${input.taskFingerprint ? `  hash ${input.taskFingerprint}` : ""}`
      : "Task  (none)",
  ];
  if (input.block) lines.push(`Blocked  ${input.block}`);
  if (denied.length) {
    for (const tool of denied) {
      lines.push(`Denied  ${tool.name}${tool.target ? ` ${tool.target}` : ""}  ${tool.deniedReason}`);
    }
  }
  lines.push(
    "Changed",
    ...(input.changed.length ? input.changed.map((file) => `- ${file}`) : ["- (none this turn)"]),
    "Checks run",
    ...(input.checks.length ? input.checks.map((item) => `- ${item}`) : ["- (none this turn)"]),
    `Next  ${input.next}`,
  );
  if (input.finishReason || input.steps !== undefined) {
    lines.push(`Diag  finish=${input.finishReason ?? "unknown"}  steps=${input.steps ?? 0}`);
  }
  if (model) {
    lines.push("", model);
  }
  return lines.join("\n");
}

export function formatReceipt(receipt: Receipt) {
  const kindOdds = Object.entries(receipt.turn.probabilities.kind)
    .map(([key, value]) => `${key}=${value.toFixed(2)}`)
    .join(" ");
  const toolLines = receipt.tools.length
    ? receipt.tools
        .map((tool) => {
          const deny = tool.deniedReason ? `  ${tool.deniedReason}` : "";
          const via = tool.source ? `  via ${tool.source}${tool.rule ? ` "${tool.rule}"` : ""}` : "";
          return `  ${tool.name}  ${tool.class}  data_loss=${tool.dataLoss.toFixed(2)}  ${tool.action}  ${tool.approved ? "ran" : "denied"}${via}${deny}`;
        })
        .join("\n")
    : "  (none)";
  return [
    "── receipt ──",
    `model       ${receipt.model}  (${receipt.routeReason})`,
    `turn        ${receipt.turn.kind}  difficulty=${receipt.turn.difficultyLabel}  repo_wide=${receipt.turn.needsRepoWide.toFixed(2)}  conf=${receipt.turn.confidence.toFixed(2)}  via ${receipt.turn.source}`,
    `kind odds   ${kindOdds}`,
    `tools`,
    toolLines,
    `time        ${receipt.ms} ms`,
    `cost        unpriced`,
    "─────────────",
    receipt.text,
  ].join("\n");
}

export function formatChat(receipt: Receipt) {
  const tools = receipt.tools.map((tool) => {
    if (tool.approved) return `tool  ${tool.name}${tool.target ? ` ${tool.target}` : ""}  ran`;
    return `tool  ${tool.name}${tool.target ? ` ${tool.target}` : ""}  denied  ${tool.deniedReason ?? ""}`.trim();
  });
  const body = receipt.text.trim() || formatTurnHandoff({
    modelText: "",
    outcome: receipt.outcome ?? "incomplete",
    tools: receipt.tools,
    block: receipt.tools.find((tool) => tool.deniedReason)?.deniedReason,
    finishReason: receipt.finishReason,
    steps: receipt.steps,
    changed: [],
    checks: [],
    next: "Inspect /task and the receipt.",
    taskId: receipt.taskId,
    taskFingerprint: receipt.taskFingerprint,
  });
  return [...(tools.length ? [...tools, ""] : []), body].join("\n");
}

export async function writeReceipt(cwd: string, receipt: Receipt) {
  const dir = path.join(cwd, ".harness", "receipts");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${receipt.sessionId}.jsonl`);
  await appendFile(file, `${JSON.stringify(receipt)}\n`, "utf8");
  return file;
}
