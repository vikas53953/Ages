import { stepCountIs, streamText, tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import { raceAbort } from "./abort.ts";
import { pickModel, unscoredTurn } from "./router.ts";
import { millicentsFromUsage, formatTurnHandoff } from "./receipt.ts";
import { serializeConfirm } from "./confirm-queue.ts";
import { runGatedTool, toolTarget, type TurnStop } from "./gated.ts";
import { scorerOf, toolGuards, type AegisPlugin, type ToolGuard, type TurnEndResult } from "./plugin-api.ts";
import { readPath } from "./tools/read.ts";
import { writePath } from "./tools/write.ts";
import { editPath } from "./tools/edit.ts";
import { grepPath } from "./tools/grep.ts";
import { runShell } from "./tools/shell.ts";
import { languageModel, modelsFor, resolveProvider, type ChatProvider } from "./providers.ts";
import { planLocal } from "./planner.ts";
import { loadSettingsSafe, type Settings } from "./rules.ts";
import { messageText, repairHistory, type ChatMessage, type MessagePart } from "./session.ts";
import type {
  ConfirmFn,
  GateConfig,
  JevClient,
  JsonObject,
  Receipt,
  ToolRecord,
  TurnDecision,
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
  /** What the model said this turn, tool calls and tool results included, ready to save in the session. */
  messages?: ChatMessage[];
}>;

export function createTools(input: {
  cwd: string;
  jev?: JevClient;
  config: GateConfig;
  confirm: ConfirmFn;
  onTool: (record: ToolRecord) => void;
  guards?: ToolGuard[];
  abortSignal?: AbortSignal;
  stop?: TurnStop;
  onEvent?: (event: TurnEvent) => void;
  settings?: Settings;
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
      settings: input.settings,
      guards: input.guards,
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
  const last = messages.at(-1);
  const prompt = last ? messageText(last) : "";
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

export const defaultGenerate: GenerateFn = (input) => generateWith(languageModel(input.model))(input);

/** Stream one turn from a given model object. Tests pass the AI SDK mock model here. */
export function generateWith(model: LanguageModel): GenerateFn {
  return async (input) => {
    const result = streamText({
      model,
      tools: input.tools,
      stopWhen: [stepCountIs(input.maxSteps), () => Boolean(input.shouldStop?.())],
      system: input.system,
      abortSignal: input.abortSignal,
      messages: toModelMessages(input.messages),
    });
    let text = "";
    for await (const delta of result.textStream) {
      if (delta) {
        text += delta;
        input.onEvent?.({ type: "text_delta", text: delta });
      }
    }
    const [finishReason, steps, usage, response] = await Promise.all([
      result.finishReason,
      result.steps,
      result.usage,
      result.response,
    ]);
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
      // Each step holds only its own messages (assistant + tool results); the turn is all of them in order.
      messages: fromModelMessages(
        stepList.length
          ? stepList.flatMap((step) => (step as { response?: { messages?: ResponseMessages } }).response?.messages ?? [])
          : (response?.messages ?? []),
      ),
    };
  };
}

type ResponseMessages = ReadonlyArray<{ role: string; content: unknown }>;

/** Session rows → what the model API expects. Broken tool pairs are dropped first. */
export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  return repairHistory(messages).map((message) => ({ role: message.role, content: message.content }) as ModelMessage);
}

/** Model API messages → session rows. JSON round-trip keeps only what can be saved to a file. */
export function fromModelMessages(messages: ReadonlyArray<{ role: string; content: unknown }>): ChatMessage[] {
  const at = new Date().toISOString();
  return messages
    .filter((message) => message.role === "assistant" || message.role === "tool")
    .map((message) => ({
      role: message.role as "assistant" | "tool",
      content: JSON.parse(JSON.stringify(message.content)) as string | MessagePart[],
      at,
    }));
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
  /** Scorer override (tests). Otherwise the first plugin scorer is used. */
  jev?: JevClient;
  /** Layer-1 plugins: guards, scorer, turn-end and receipt hooks. */
  plugins?: AegisPlugin[];
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
  toolsCwd?: string;
}): Promise<Receipt> {
  const started = Date.now();
  const stop: TurnStop = {};
  input.onEvent?.({ type: "accepted" });
  // Rules and Jev mode come from the project folder, even when tools run in a task work folder.
  const settings = loadSettingsSafe(input.cwd).settings;
  const plugins = input.plugins ?? [];
  const scorer = input.jev ?? scorerOf(plugins);
  if (input.abortSignal?.aborted) throw new Error("cancelled");
  let turn: TurnDecision;
  if (!scorer || settings.jev.mode === "off") {
    turn = unscoredTurn();
  } else {
    input.onEvent?.({ type: "evaluating" });
    const turnResult = await raceAbort(
      scorer
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
    turn = turnResult.turn;
  }
  const models = modelsFor(input.provider ?? resolveProvider(), input.config);
  const route = input.model
    ? { model: input.model, reason: "selected" }
    : turn.source === "off"
      ? { model: models.frontier, reason: "jev off" }
      : pickModel(turn, {
        ...input.config,
        cheapModel: models.cheap,
        frontierModel: models.frontier,
      });
  input.onEvent?.({ type: "route", model: route.model, reason: route.reason });
  const toolsUsed: ToolRecord[] = [];
  const tools = createTools({
    cwd: input.toolsCwd ?? input.cwd,
    jev: scorer,
    guards: toolGuards(plugins),
    config: input.config,
    confirm: input.confirm,
    abortSignal: input.abortSignal,
    stop,
    onEvent: input.onEvent,
    settings,
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
  // A plugin guard (delivery agreement) that blocked a change stops the turn.
  const agreementBlock = toolsUsed.find((tool) => !tool.approved && tool.source === "agreement")?.deniedReason
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
  const extra: TurnEndResult = {};
  for (const plugin of plugins) {
    Object.assign(extra, await plugin.turnEnd?.({ cwd: input.cwd, tools: toolsUsed, stopReason: agreementBlock, outcome }));
  }
  const next =
    extra.next ??
    (agreementBlock
      ? "A plugin blocked a change; see Blocked above."
      : outcome === "incomplete"
        ? "Ask again or inspect the receipt finish reason and step count."
        : "Ask a follow-up, or /compact when the session gets long.");
  const task = extra.taskId ? { agreement: { id: extra.taskId }, fingerprint: extra.taskFingerprint } : undefined;
  const permission = extra.taskPermission;
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
    newMessages:
      result.messages ??
      (result.text.trim() ? [{ role: "assistant", content: result.text, at: new Date().toISOString() }] : []),
  };
  for (const plugin of plugins) await plugin.onReceipt?.(receipt, { cwd: input.cwd });
  return receipt;
}

export { formatReceipt, formatChat } from "./receipt.ts";
