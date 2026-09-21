export function pickModel(decision, config) {
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
