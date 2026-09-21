import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { decideToolAction } from "../src/policy.ts";
import type { ToolDecision } from "../src/types.ts";

const config = loadConfig();

function tool(partial: Partial<ToolDecision>): ToolDecision {
  return {
    class: "read_only",
    dataLoss: 0.05,
    confidence: 0.9,
    probabilities: {
      class: { read_only: 0.9, reversible: 0.05, irreversible: 0.05 },
    },
    source: "mock",
    ...partial,
  };
}

describe("decideToolAction", () => {
  it("auto-runs read-only tools", () => {
    expect(decideToolAction(tool({}), config)).toBe("auto");
  });

  it("auto-runs a high-confidence reversible write", () => {
    expect(
      decideToolAction(tool({ class: "reversible", confidence: 0.85 }), config),
    ).toBe("auto");
  });

  it("asks before a low-confidence reversible write", () => {
    expect(
      decideToolAction(tool({ class: "reversible", confidence: 0.4 }), config),
    ).toBe("confirm");
  });

  it("always asks before an irreversible tool", () => {
    expect(
      decideToolAction(
        tool({ class: "irreversible", confidence: 0.99, dataLoss: 0.1 }),
        config,
      ),
    ).toBe("confirm");
  });

  it("always asks when data-loss is at least 0.5", () => {
    expect(
      decideToolAction(tool({ class: "read_only", dataLoss: 0.5 }), config),
    ).toBe("confirm");
  });

  it("denies when Jev fail-closed", () => {
    expect(
      decideToolAction(
        tool({ source: "fail_closed", class: "irreversible", dataLoss: 1, confidence: 0 }),
        config,
      ),
    ).toBe("deny");
  });
});
