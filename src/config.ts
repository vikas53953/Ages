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
  maxSteps: 8,
  shellTimeoutMs: 30_000,
};

export function loadConfig(cwd = process.cwd()): GateConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(cwd, "gate.config.json"),
    path.join(here, "..", "gate.config.json"),
  ];
  let file: Partial<GateConfig> = {};
  for (const candidate of candidates) {
    try {
      file = JSON.parse(readFileSync(candidate, "utf8")) as Partial<GateConfig>;
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
