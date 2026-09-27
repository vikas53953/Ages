/** Jev's score → auto or confirm. Jev cannot deny: when it fails, you are asked. */
export function decideToolAction(decision, config) {
    if (decision.source === "fail_closed")
        return "confirm";
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
const STRICTNESS = { auto: 0, confirm: 1, deny: 2 };
/** The stricter of two actions. Jev can tighten a rule this way, never loosen it. */
export function stricter(a, b) {
    return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}
