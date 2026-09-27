/**
 * The contract between the Aegis core (layer 0) and plugins (layer 1).
 *
 * The core owns the loop, the session, the tools, compaction, the router and the rules gate.
 * A plugin adds behaviour by filling in any of the hooks below. The core runs fine with none.
 *
 * Hook order in one turn:
 *   systemPrompt (context:assemble) → scorer.evaluateTurn (model:route)
 *   → for each tool call: guardTool → rules → scorer.evaluateTool (tool:before) → you → run
 *   → turnEnd (turn:end) → onReceipt
 */
import type { AppState, HandleResult, RunOpts } from "./runtime.ts";
import type { TurnEvent } from "./loop.ts";
import type { ConfirmFn, JevClient, Receipt, TaskPermission, ToolRecord, TurnOutcome } from "./types.ts";

export type ToolCall = { name: string; args: Record<string, unknown>; cwd: string };

/** First check on a tool call. Return a reason to block it; that also stops the rest of the turn. */
export type ToolGuard = (call: ToolCall) => Promise<string | undefined>;

export type TurnEndInfo = { cwd: string; tools: ToolRecord[]; stopReason?: string; outcome: TurnOutcome };

/** What a plugin can add to the end-of-turn handoff. */
export type TurnEndResult = {
  block?: string;
  next?: string;
  taskId?: string;
  taskFingerprint?: string;
  taskPermission?: TaskPermission;
};

export type CommandContext = {
  state: AppState;
  opts: RunOpts;
  confirm: ConfirmFn;
  onEvent?: (event: TurnEvent) => void;
};

export type CommandHandler = (arg: string, ctx: CommandContext) => Promise<HandleResult>;

export type AegisPlugin = {
  name: string;
  /** Lines added to /help. */
  help?: string[];
  /** Slash commands, keyed by name without the slash. */
  commands?: Record<string, CommandHandler>;
  /** Scores turns (cheap vs frontier) and tool calls (auto vs ask). Only the first scorer is used. */
  scorer?: JevClient;
  /** tool:before, runs before the rules. */
  guardTool?: ToolGuard;
  /** context:assemble — text added to the system prompt. */
  systemPrompt?: (ctx: { cwd: string; sessionId: string }) => Promise<string | undefined>;
  /** May answer a plain prompt itself instead of sending it to the model. */
  beforePrompt?: (text: string, ctx: CommandContext) => Promise<HandleResult | undefined>;
  /** Runs before every plain prompt that reaches the model. */
  beforeTurn?: (ctx: CommandContext) => Promise<void>;
  /** turn:end — may add a block, a next step, or task fields to the handoff. */
  turnEnd?: (info: TurnEndInfo) => Promise<TurnEndResult | undefined>;
  /** After the receipt is built. */
  onReceipt?: (receipt: Receipt, ctx: { cwd: string }) => Promise<void>;
  /** At start and on /new, /clear. */
  onSessionStart?: (cwd: string) => Promise<void>;
  /** Task state for the footer and /status. */
  taskPermission?: (cwd: string) => Promise<TaskPermission>;
};

export function toolGuards(plugins: AegisPlugin[] = []): ToolGuard[] {
  return plugins.flatMap((plugin) => (plugin.guardTool ? [plugin.guardTool] : []));
}

export function scorerOf(plugins: AegisPlugin[] = []): JevClient | undefined {
  return plugins.find((plugin) => plugin.scorer)?.scorer;
}
