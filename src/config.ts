import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GateConfig } from "./types.ts";

const defaults: GateConfig = {
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

const PROJECT_CONFIG_KEYS = ["jevModel", "cheapModel", "frontierModel", "maxSteps", "shellTimeoutMs", "compactAtChars", "compactKeepTurns"] as const;

function pickProjectConfig(parsed: Partial<GateConfig>): Partial<GateConfig> {
  const out: Record<string, unknown> = {};
  for (const key of PROJECT_CONFIG_KEYS) if (parsed[key] !== undefined) out[key] = parsed[key];
  return out as Partial<GateConfig>;
}

export function loadConfig(cwd = process.cwd()): GateConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(cwd, "gate.config.json"),
    path.join(here, "..", "gate.config.json"),
  ];
  let file: Partial<GateConfig> = {};
  for (const [index, candidate] of candidates.entries()) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<GateConfig>;
      // A project's own gate.config.json may tune models and limits, never the lock's thresholds.
      file = index === 0 ? pickProjectConfig(parsed) : parsed;
      break;
    } catch {
      // try next
    }
  }
  return {
    ...defaults,
    ...file,
    cheapModel: process.env.GATE_CHEAP_MODEL || file.cheapModel || defaults.cheapModel,
    frontierModel:
      process.env.GATE_FRONTIER_MODEL || file.frontierModel || defaults.frontierModel,
  };
}
