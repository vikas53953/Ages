import type { ChatMessage } from "./session.ts";

export const TURN_KINDS = ["lookup", "edit", "architecture"] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

export const DIFFICULTY_LABELS = ["trivial", "minor", "moderate", "hard"] as const;
export type DifficultyLabel = (typeof DIFFICULTY_LABELS)[number];

export const TOOL_CLASSES = ["read_only", "reversible", "irreversible"] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

export type PolicyAction = "auto" | "confirm" | "deny";

export type TurnState = {
  prompt: string;
  cwd: string;
  recent_tools: string[];
  open_files: string[];
};

export type JsonObject = { [key: string]: string | number | boolean | null };

export type ToolState = {
  name: string;
  args: JsonObject;
  cwd: string;
  git: boolean;
};

export type TurnDecision = {
  kind: TurnKind;
  difficulty: number;
  difficultyLabel: DifficultyLabel;
  needsRepoWide: number;
  confidence: number;
  probabilities: { kind: Record<TurnKind, number> };
  source: "jev" | "mock" | "fail_closed" | "off";
};

export type ToolDecision = {
  class: ToolClass;
  dataLoss: number;
  confidence: number;
  probabilities: { class: Record<ToolClass, number> };
  source: "jev" | "mock" | "fail_closed";
};

export type GateConfig = {
  jevModel: string;
  cheapModel: string;
  frontierModel: string;
  needsRepoWideThreshold: number;
  highConfidence: number;
  lowConfidence: number;
  dataLossThreshold: number;
  maxSteps: number;
  shellTimeoutMs: number;
  /** Compact before a turn once saved history is bigger than this many characters (about 4 per token). 0 = never. */
  compactAtChars: number;
  /** Recent user turns kept word for word when compacting. */
  compactKeepTurns: number;
};

export type JevClient = {
  evaluateTurn(state: TurnState, abortSignal?: AbortSignal): Promise<TurnDecision>;
  evaluateTool(state: ToolState, abortSignal?: AbortSignal): Promise<ToolDecision>;
};

/** What a y/N prompt can offer beyond yes and no. */
export type ConfirmOptions = {
  /** An allow rule that "always" would save, e.g. "edit scripts/*". Absent: only yes / no. */
  always?: string;
  /** Structured facts for a richer card (the Studio face): tool, target, why. */
  tool?: string;
  target?: string;
  why?: string;
  /** The question as a card (the terminal draws it like Claude Code); the plain question text is the fallback. */
  card?: import("./confirm-card.ts").ConfirmCard;
};
/** true = yes this once, false = no, "always" = yes and save the offered allow rule. */
export type ConfirmAnswer = boolean | "always";
export type ConfirmFn = (question: string, options?: ConfirmOptions) => Promise<ConfirmAnswer>;

export type JevHealth = "mock" | "live" | "down" | "blocked" | "off";
export type TaskPermission = "untracked" | "proposed" | "confirmed" | "invalid";
export type TurnOutcome = "completed" | "blocked" | "incomplete" | "cancelled";
/** rule = decided by .aegis/settings.json; default = no rule and no Jev, so you were asked. */
export type ToolSource = "jev" | "mock" | "fail_closed" | "agreement" | "rule" | "hook" | "default" | "mode";
/**
 * What "no rule matched" means this session (Shift+Tab, /mode, /yolo). ask: you are asked (the default).
 * auto: file writes and edits in the folder run without asking. yolo: everything runs without asking.
 * In every mode deny rules block and ask rules ask; Jev, when it really scored, can still make a call ask or block.
 */
export type PermissionMode = "ask" | "auto" | "yolo";
/** The mode, or how to read it now: a getter makes a switch (yolo off mid-turn) count from the very next call. */
export type ModeSource = PermissionMode | (() => PermissionMode | undefined);

export type TurnEvent =
  | { type: "accepted" }
  | { type: "evaluating" }
  | { type: "route"; model: string; reason: string }
  | { type: "waiting_model" }
  | { type: "tool_start"; name: string; target?: string }
  /** A tool call the model is still writing (e.g. a big file): what has arrived so far. Display only. */
  | { type: "tool_input"; id: string; name: string; path?: string; chars: number; lines: number; tail: string[] }
  | { type: "awaiting_approval"; name: string; target?: string }
  | { type: "tool"; record: ToolRecord }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  /** The model's todo list changed. */
  | { type: "todos"; todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }> }
  /** A line to show now, before the command finishes (the ChatGPT sign-in code). */
  | { type: "notice"; text: string }
  | { type: "outcome"; outcome: TurnOutcome };

export type ToolRecord = {
  /** Made by this custom agent (agents/<name>.md), not the main conversation. */
  via?: string;
  name: string;
  class: ToolClass;
  dataLoss: number;
  confidence: number;
  action: PolicyAction;
  approved: boolean;
  deniedReason?: string;
  target?: string;
  source?: ToolSource;
  rule?: string;
  /** The allow rule you saved with "always" on this call's prompt. */
  savedRule?: string;
  /** A PreToolUse hook that denied this call or made Aegis ask. */
  hook?: string;
  /** How many secret-looking values were cut from the output before the model saw it. */
  redacted?: number;
  /** Set when you chose "always" but the rule could not be saved (the call still ran once). */
  saveFailed?: string;
  /** What happened, in plain words, for the transcript: "Created · 381 lines", "12 files". */
  summary?: string;
  /** A write that made a new file (not one that replaced a file). */
  created?: boolean;
  /** A few lines to show under the summary (the start of a new file), secrets cut. */
  preview?: string[];
  /** The session mode that let this call run without asking (source "mode"). */
  mode?: PermissionMode;
};

export type Receipt = {
  sessionId: string;
  prompt: string;
  model: string;
  routeReason: string;
  turn: TurnDecision;
  tools: ToolRecord[];
  ms: number;
  millicents: number;
  text: string;
  outcome?: TurnOutcome;
  finishReason?: string;
  steps?: number;
  taskId?: string;
  taskFingerprint?: string;
  taskPermission?: TaskPermission;
  /** Tokens this turn used, across every step (input, output, and the part of output spent reasoning). */
  tokens?: { input: number; output: number; reasoning?: number };
  /** The model's own answer text, without the handoff card. */
  answer?: string;
  /** Messages this turn added to the conversation. Saved to the session, not to the receipt file. */
  newMessages?: ChatMessage[];
};
