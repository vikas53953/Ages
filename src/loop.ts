import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { raceAbort } from "./abort.ts";
import { pickModel } from "./router.ts";
import { millicentsFromUsage, writeReceipt, formatTurnHandoff } from "./receipt.ts";
import { serializeConfirm } from "./confirm-queue.ts";
import { runGatedTool, toolTarget, type TurnStop } from "./gated.ts";
import { isTerminalAgreementBlock, loadTask, taskPermission } from "./delivery.ts";
import { readPath } from "./tools/read.ts";
import { writePath } from "./tools/write.ts";
import { editPath } from "./tools/edit.ts";
import { grepPath } from "./tools/grep.ts";
import { runShell } from "./tools/shell.ts";
import { languageModel, modelsFor, resolveProvider, type ChatProvider } from "./providers.ts";
import { planLocal } from "./planner.ts";
import type { ChatMessage } from "./session.ts";
import type {
  ConfirmFn,
  GateConfig,
  JevClient,
  JsonObject,
  Receipt,
  ToolRecord,
  TurnEvent,
  TurnOutcome,
} from "./types.ts";

export type { TurnEvent } from "./types.ts";

export type GenerateFn = (input: {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ReturnType<typeof createTools>;
  maxSteps: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: TurnEvent) => void;
  shouldStop?: () => boolean;
}) => Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  finishReason?: string;
  steps?: number;
  finalStepComplete?: boolean;
}>;

export function createTools(input: {
  cwd: string;
  jev: JevClient;
  config: GateConfig;
  confirm: ConfirmFn;
  onTool: (record: ToolRecord) => void;
  abortSignal?: AbortSignal;
  stop?: TurnStop;
  onEvent?: (event: TurnEvent) => void;
}) {
  const confirm = serializeConfirm(input.confirm);
  const gate = (name: string, args: JsonObject, execute: () => Promise<string>) => {
    if (input.stop?.reason) {
      return Promise.resolve(
        JSON.stringify({ denied: true, reason: input.stop.reason, stopped: true, class: "irreversible" }),
      );
    }
    const target = toolTarget(name, args);
    input.onEvent?.({ type: "tool_start", name, target: target || undefined });
    return runGatedTool({
      name,
      args,
      cwd: input.cwd,
      jev: input.jev,
      config: input.config,
      confirm,
      abortSignal: input.abortSignal,
      execute,
      stop: input.stop,
      onEvent: input.onEvent,
    }).then((result) => {
      input.onTool(result.record);
      return result.output;
    });
  };

  return {
    read: tool({
      description: "Read a file or list a directory. Path is relative to the working folder.",
      inputSchema: z.object({
        path: z.string().describe("Relative path. Use . for the working folder."),
      }),
      execute: async ({ path: filePath }) =>
        gate("read", { path: filePath }, () => readPath(filePath, input.cwd)),
    }),
    write: tool({
      description: "Write a new text file, or replace a whole file, inside the working folder.",
      inputSchema: z.object({
        path: z.string(),
        contents: z.string(),
      }),
      execute: async ({ path: filePath, contents }) =>
        gate("write", { path: filePath, contents }, () =>
          writePath(filePath, contents, input.cwd),
        ),
    }),
    edit: tool({
      description:
        "Replace one unique string in an existing file. Prefer this over write when changing a file.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      execute: async ({ path: filePath, old_string, new_string }) =>
        gate("edit", { path: filePath, old_string, new_string }, () =>
          editPath(filePath, old_string, new_string, input.cwd),
        ),
    }),
    grep: tool({
      description: "Search files under a relative path with a regex.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
      }),
      execute: async ({ pattern, path: filePath }) =>
        gate("grep", { pattern, path: filePath ?? "." }, () =>
          grepPath(pattern, filePath ?? ".", input.cwd),
        ),
    }),
    shell: tool({
      description:
        "Run one PowerShell command in the working folder. Do not use this to leave the folder.",
      inputSchema: z.object({
        command: z.string(),
      }),
      execute: async ({ command }) =>
        gate("shell", { command }, async () => {
          const { stdout, stderr } = await runShell(command, input.cwd, input.abortSignal);
          return [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
        }),
    }),
  };
}

const localOpts = { toolCallId: "local", messages: [], context: {} } as never;

export const localGenerate: GenerateFn = async ({ tools, messages }) => {
  const prompt = messages.at(-1)?.content ?? "";
  const plan = planLocal(prompt);
  if (plan.tool === "read") {
    const listing = await tools.read.execute!({ path: plan.path }, localOpts);
    return { text: String(listing), inputTokens: 0, outputTokens: 0 };
  }
  if (plan.tool === "grep") {
    const hits = await tools.grep.execute!(
      { pattern: plan.pattern, path: plan.path },
      localOpts,
    );
    return { text: String(hits), inputTokens: 0, outputTokens: 0 };
  }
  return {
    text: [
      "Local planner only (--local). I can list, read, or search.",
      "Try: list files here | read README.md | search for runLoop",
    ].join("\n"),
    inputTokens: 0,
    outputTokens: 0,
    finishReason: "stop",
    steps: 1,
  };
};

export async function defaultGenerate(input: {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ReturnType<typeof createTools>;
  maxSteps: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: TurnEvent) => void;
  shouldStop?: () => boolean;
}) {
  const result = streamText({
    model: languageModel(input.model),
    tools: input.tools,
    stopWhen: [stepCountIs(input.maxSteps), () => Boolean(input.shouldStop?.())],
    system: input.system,
    abortSignal: input.abortSignal,
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  });
  let text = "";
  for await (const delta of result.textStream) {
    if (delta) {
      text += delta;
      input.onEvent?.({ type: "text_delta", text: delta });
    }
  }
  const [finishReason, steps, usage] = await Promise.all([result.finishReason, result.steps, result.usage]);
  const stepList = Array.isArray(steps) ? steps : [];
  const last = stepList.at(-1) as { finishReason?: string; text?: string } | undefined;
  const lastReason = last?.finishReason ?? String(finishReason);
  const finalStepComplete = lastReason !== "tool-calls" && lastReason !== "length";
  return {
    text,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    finishReason: String(finishReason),
    steps: stepList.length,
    finalStepComplete,
  };
}

export function classifyTurnOutcome(input: {
  aborted?: boolean;
  agreementBlock?: string;
  finishReason?: string;
  steps?: number;
  maxSteps: number;
  text: string;
  finalStepComplete?: boolean;
}): TurnOutcome {
  if (input.aborted) return "cancelled";
  if (input.agreementBlock) return "blocked";
  const reason = input.finishReason ?? "";
  const steps = input.steps ?? 0;
  const unfinishedTools = reason === "tool-calls" || input.finalStepComplete === false;
  const truncated = reason === "length" || reason === "max-steps";
  const hitCapUnfinished = steps >= input.maxSteps && input.finalStepComplete !== true;
  if (unfinishedTools || truncated || hitCapUnfinished || !input.text.trim()) return "incomplete";
  return "completed";
}

export async function runLoop(input: {
  prompt: string;
  cwd: string;
  jev: JevClient;
  config: GateConfig;
  confirm: ConfirmFn;
  sessionId: string;
  generate?: GenerateFn;
  system?: string;
  history?: ChatMessage[];
  provider?: ChatProvider;
  model?: string;
  abortSignal?: AbortSignal;
  onEvent?: (event: TurnEvent) => void;
}): Promise<Receipt> {
  const started = Date.now();
  const stop: TurnStop = {};
  input.onEvent?.({ type: "accepted" });
  input.onEvent?.({ type: "evaluating" });
  if (input.abortSignal?.aborted) throw new Error("cancelled");
  const turnResult = await raceAbort(
    input.jev
      .evaluateTurn(
        {
          prompt: input.prompt,
          cwd: input.cwd,
          recent_tools: [],
          open_files: [],
        },
        input.abortSignal,
      )
      .then((turn) => ({ kind: "turn" as const, turn })),
    input.abortSignal,
    () => ({ kind: "abort" as const }),
  );
  if (turnResult.kind === "abort" || input.abortSignal?.aborted) throw new Error("cancelled");
  const turn = turnResult.turn;
  const models = modelsFor(input.provider ?? resolveProvider(), input.config);
  const route = input.model
    ? { model: input.model, reason: "selected" }
    : pickModel(turn, {
        ...input.config,
        cheapModel: models.cheap,
        frontierModel: models.frontier,
      });
  input.onEvent?.({ type: "route", model: route.model, reason: route.reason });
  const toolsUsed: ToolRecord[] = [];
  const tools = createTools({
    cwd: input.cwd,
    jev: input.jev,
    config: input.config,
    confirm: input.confirm,
    abortSignal: input.abortSignal,
    stop,
    onEvent: input.onEvent,
    onTool: (record) => {
      toolsUsed.push(record);
      input.onEvent?.({ type: "tool", record });
    },
  });
  const generate = input.generate ?? defaultGenerate;
  const history = [
    ...(input.history ?? []),
    { role: "user" as const, content: input.prompt, at: new Date().toISOString() },
  ];
  input.onEvent?.({ type: "waiting_model" });
  const result = await generate({
    model: route.model,
    system: input.system ?? "You are Aegis, a custom coding-agent CLI. Jev locks spend and danger.",
    messages: history,
    tools,
    maxSteps: input.config.maxSteps,
    abortSignal: input.abortSignal,
    onEvent: input.onEvent,
    shouldStop: () => Boolean(stop.reason),
  });
  const task = await loadTask(input.cwd).catch(() => undefined);
  const permission = await taskPermission(input.cwd);
  const agreementBlock = toolsUsed.find((tool) => isTerminalAgreementBlock(tool.deniedReason))?.deniedReason
    ?? stop.reason;
  const outcome = classifyTurnOutcome({
    aborted: input.abortSignal?.aborted,
    agreementBlock,
    finishReason: result.finishReason,
    steps: result.steps,
    maxSteps: input.config.maxSteps,
    text: result.text,
    finalStepComplete: result.finalStepComplete,
  });
  const changed = toolsUsed
    .filter((tool) => tool.approved && (tool.name === "write" || tool.name === "edit"))
    .map((tool) => tool.target || tool.name);
  const checks = toolsUsed
    .filter((tool) => tool.name === "shell" && tool.approved)
    .map((tool) => tool.target || "shell");
  const next = agreementBlock
    ? "Confirm the displayed agreement, or /task new <id> for a different task. Do not reply yes unless a pending confirm is shown."
    : outcome === "incomplete"
      ? "Ask again or inspect the receipt finish reason and step count."
      : "Review the card with /task. Only you can /task accept.";
  const text = formatTurnHandoff({
    modelText: result.text,
    outcome,
    tools: toolsUsed,
    block: agreementBlock,
    finishReason: result.finishReason,
    steps: result.steps,
    changed,
    checks,
    next,
    taskId: task?.agreement.id,
    taskFingerprint: task?.fingerprint,
  });
  input.onEvent?.({ type: "outcome", outcome });
  const receipt: Receipt = {
    sessionId: input.sessionId,
    prompt: input.prompt,
    model: route.model,
    routeReason: route.reason,
    turn,
    tools: toolsUsed,
    ms: Date.now() - started,
    millicents: millicentsFromUsage(result.inputTokens, result.outputTokens),
    text,
    outcome,
    finishReason: result.finishReason,
    steps: result.steps,
    taskId: task?.agreement.id,
    taskFingerprint: task?.fingerprint,
    taskPermission: permission,
  };
  await writeReceipt(input.cwd, receipt);
  return receipt;
}

export { formatReceipt, formatChat } from "./receipt.ts";
