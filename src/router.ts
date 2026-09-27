import type { GateConfig, TurnDecision } from "./types.ts";

export function pickModel(
  decision: TurnDecision,
  config: GateConfig,
): { model: string; reason: string } {
  if (decision.kind === "architecture") {
    return { model: config.frontierModel, reason: "kind=architecture" };
  }
  if (decision.difficulty >= 3) {
    return { model: config.frontierModel, reason: "difficulty=hard" };
  }
  if (decision.needsRepoWide >= config.needsRepoWideThreshold) {
    return { model: config.frontierModel, reason: "needs_repo_wide" };
  }
  if (decision.confidence < config.lowConfidence) {
    return { model: config.frontierModel, reason: "low_confidence" };
  }
  if (decision.kind === "lookup" && decision.difficulty <= 1) {
    return { model: config.cheapModel, reason: "lookup+trivial/minor" };
  }
  return { model: config.frontierModel, reason: "default_frontier" };
}

/** The turn record when nothing scored it (Jev off or not installed). The router is skipped; the pinned or frontier model runs. */
export function unscoredTurn(): TurnDecision {
  return {
    kind: "architecture",
    difficulty: 3,
    difficultyLabel: "hard",
    needsRepoWide: 1,
    confidence: 0,
    probabilities: { kind: { lookup: 0, edit: 0, architecture: 1 } },
    source: "off",
  };
}
