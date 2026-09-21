export function decideToolAction(decision, config) {
    if (decision.source === "fail_closed")
        return "deny";
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
