import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const defaults = {
    jevModel: "jev-latest",
    cheapModel: "gpt-4.1-mini",
    frontierModel: "gpt-4.1",
    needsRepoWideThreshold: 0.7,
    highConfidence: 0.7,
    lowConfidence: 0.5,
    dataLossThreshold: 0.5,
    maxSteps: 25,
    shellTimeoutMs: 30_000,
    compactAtChars: 120_000,
    compactKeepTurns: 3,
};
const PROJECT_CONFIG_KEYS = ["jevModel", "cheapModel", "frontierModel", "maxSteps", "shellTimeoutMs", "compactAtChars", "compactKeepTurns"];
function pickProjectConfig(parsed) {
    const out = {};
    for (const key of PROJECT_CONFIG_KEYS)
        if (parsed[key] !== undefined)
            out[key] = parsed[key];
    return out;
}
export function loadConfig(cwd = process.cwd()) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        path.join(cwd, "gate.config.json"),
        path.join(here, "..", "gate.config.json"),
    ];
    let file = {};
    for (const [index, candidate] of candidates.entries()) {
        try {
            const parsed = JSON.parse(readFileSync(candidate, "utf8"));
            // A project's own gate.config.json may tune models and limits, never the lock's thresholds.
            file = index === 0 ? pickProjectConfig(parsed) : parsed;
            break;
        }
        catch {
            // try next
        }
    }
    return {
        ...defaults,
        ...file,
        cheapModel: process.env.GATE_CHEAP_MODEL || file.cheapModel || defaults.cheapModel,
        frontierModel: process.env.GATE_FRONTIER_MODEL || file.frontierModel || defaults.frontierModel,
    };
}
