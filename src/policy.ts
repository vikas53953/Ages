import type { GateConfig, PolicyAction, ToolDecision } from "./types.ts";

export function decideToolAction(
  decision: ToolDecision,
  config: GateConfig,
): PolicyAction {
  if (decision.source === "fail_closed") return "deny";
  if (decision.class === "irreversible" || decision.dataLoss >= config.dataLossThreshold) {
    return "confirm";
  }
  if (decision.class === "read_only") {
    return "auto";
  }
  if (decision.confidence >= config.highConfidence) {
    return "auto";
  }
  return "confirm";
}
