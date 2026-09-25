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

export type ConfirmFn = (question: string) => Promise<boolean>;

export type JevHealth = "mock" | "live" | "down" | "blocked" | "off";
export type TaskPermission = "untracked" | "proposed" | "confirmed" | "invalid";
export type TurnOutcome = "completed" | "blocked" | "incomplete" | "cancelled";
/** rule = decided by .aegis/settings.json; default = no rule and no Jev, so you were asked. */
export type ToolSource = "jev" | "mock" | "fail_closed" | "agreement" | "rule" | "default";

export type TurnEvent =
  | { type: "accepted" }
  | { type: "evaluating" }
  | { type: "route"; model: string; reason: string }
  | { type: "waiting_model" }
  | { type: "tool_start"; name: string; target?: string }
  | { type: "awaiting_approval"; name: string; target?: string }
  | { type: "tool"; record: ToolRecord }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "outcome"; outcome: TurnOutcome };

export type ToolRecord = {
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
