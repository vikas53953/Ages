import { experimental_evaluate } from "ai";
import { createTypeSafeAi, typeSafeAi } from "@ai-sdk/typesafe-ai";
import { hasJevCredentials, jevApiKey } from "../../env.ts";
import {
  DIFFICULTY_LABELS,
  TOOL_CLASSES,
  TURN_KINDS,
  type DifficultyLabel,
  type JevClient,
  type ToolClass,
  type ToolDecision,
  type ToolState,
  type TurnDecision,
  type TurnKind,
  type TurnState,
} from "../../types.ts";
import { TOOL_QUESTIONS, TURN_QUESTIONS } from "./questions.ts";

function evaluationModel() {
  const key = jevApiKey();
  if (process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_AI_API_KEY) {
    return createTypeSafeAi({ apiKey: key }).evaluationModel("jev-latest");
  }
  if (key) {
    return typeSafeAi.evaluationModel("jev-latest");
  }
  return "typesafe-ai/jev-latest";
}

function confidenceFrom(result: { providerMetadata?: Record<string, unknown> }) {
  const typesafe = result.providerMetadata?.typesafe as
    | { confidence?: Record<string, number> }
    | undefined;
  const values = Object.values(typesafe?.confidence ?? {});
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function asKind(value: string | undefined): TurnKind | undefined {
  return TURN_KINDS.includes(value as TurnKind) ? (value as TurnKind) : undefined;
}

function asClass(value: string | undefined): ToolClass | undefined {
  return TOOL_CLASSES.includes(value as ToolClass) ? (value as ToolClass) : undefined;
}

function asDifficulty(score: number | undefined): {
  difficulty: number;
  difficultyLabel: DifficultyLabel;
} {
  const raw = typeof score === "number" && Number.isFinite(score) ? score : 0;
  const difficulty = Math.min(3, Math.max(0, Math.round(raw > 3 ? raw - 1 : raw)));
  return { difficulty, difficultyLabel: DIFFICULTY_LABELS[difficulty] };
}

export function failClosedTurn(): TurnDecision {
  return {
    kind: "architecture",
    difficulty: 3,
    difficultyLabel: "hard",
    needsRepoWide: 1,
    confidence: 0,
    probabilities: { kind: { lookup: 0, edit: 0, architecture: 1 } },
    source: "fail_closed",
  };
}

export function failClosedTool(): ToolDecision {
  return {
    class: "irreversible",
    dataLoss: 1,
    confidence: 0,
    probabilities: { class: { read_only: 0, reversible: 0, irreversible: 1 } },
    source: "fail_closed",
  };
}

export async function evaluateTurn(state: TurnState, abortSignal?: AbortSignal): Promise<TurnDecision> {
  if (abortSignal?.aborted) return failClosedTurn();
  if (!hasJevCredentials()) {
    return failClosedTurn();
  }
  try {
    const result = await experimental_evaluate({
      model: evaluationModel(),
      state,
      questions: TURN_QUESTIONS,
      abortSignal,
    });
    const { difficulty, difficultyLabel } = asDifficulty(
      result.answers.difficulty.score,
    );
    const kind = asKind(result.answers.kind.choice);
    if (!kind) return failClosedTurn();
    const empty = { lookup: 0, edit: 0, architecture: 0 };
    return {
      kind,
      difficulty,
      difficultyLabel,
      needsRepoWide: result.answers.needs_repo_wide.probability,
      confidence: confidenceFrom(result),
      probabilities: {
        kind: { ...empty, ...(result.answers.kind.probabilities ?? {}) },
      },
      source: "jev",
    };
  } catch {
    if (abortSignal?.aborted) return failClosedTurn();
    return failClosedTurn();
  }
}

export async function evaluateTool(state: ToolState, abortSignal?: AbortSignal): Promise<ToolDecision> {
  if (abortSignal?.aborted) return failClosedTool();
  if (!hasJevCredentials()) {
    return failClosedTool();
  }
  try {
    const result = await experimental_evaluate({
      model: evaluationModel(),
      state,
      questions: TOOL_QUESTIONS,
      abortSignal,
    });
    const toolClass = asClass(result.answers.class.choice);
    if (!toolClass) return failClosedTool();
    const empty = { read_only: 0, reversible: 0, irreversible: 0 };
    return {
      class: toolClass,
      dataLoss: result.answers.data_loss.probability,
      confidence: confidenceFrom(result),
      probabilities: {
        class: { ...empty, ...(result.answers.class.probabilities ?? {}) },
      },
      source: "jev",
    };
  } catch {
    if (abortSignal?.aborted) return failClosedTool();
    return failClosedTool();
  }
}

export function liveJev(): JevClient {
  return { evaluateTurn, evaluateTool };
}
