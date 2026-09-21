import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { pickModel } from "../src/router.ts";
import type { TurnDecision } from "../src/types.ts";

const config = loadConfig();

function turn(partial: Partial<TurnDecision>): TurnDecision {
  return {
    kind: "lookup",
    difficulty: 0,
    difficultyLabel: "trivial",
    needsRepoWide: 0.1,
    confidence: 0.9,
    probabilities: { kind: { lookup: 0.9, edit: 0.05, architecture: 0.05 } },
    source: "mock",
    ...partial,
  };
}

describe("pickModel", () => {
  it("uses the cheap model for a trivial lookup", () => {
    const picked = pickModel(turn({}), config);
    expect(picked.model).toBe(config.cheapModel);
    expect(picked.reason).toBe("lookup+trivial/minor");
  });

  it("uses the cheap model for a minor lookup", () => {
    const picked = pickModel(
      turn({ difficulty: 1, difficultyLabel: "minor" }),
      config,
    );
    expect(picked.model).toBe(config.cheapModel);
  });

  it("uses the frontier model for architecture", () => {
    const picked = pickModel(turn({ kind: "architecture" }), config);
    expect(picked.model).toBe(config.frontierModel);
    expect(picked.reason).toBe("kind=architecture");
  });

  it("uses the frontier model when difficulty is hard", () => {
    const picked = pickModel(
      turn({ difficulty: 3, difficultyLabel: "hard" }),
      config,
    );
    expect(picked.model).toBe(config.frontierModel);
    expect(picked.reason).toBe("difficulty=hard");
  });

  it("uses the frontier model when the repo-wide noul is high", () => {
    const picked = pickModel(turn({ needsRepoWide: 0.8 }), config);
    expect(picked.model).toBe(config.frontierModel);
    expect(picked.reason).toBe("needs_repo_wide");
  });

  it("fails closed to frontier when confidence is low", () => {
    const picked = pickModel(turn({ confidence: 0.3 }), config);
    expect(picked.model).toBe(config.frontierModel);
    expect(picked.reason).toBe("low_confidence");
  });

  it("uses frontier for an edit that is not clearly cheap", () => {
    const picked = pickModel(turn({ kind: "edit", difficulty: 2 }), config);
    expect(picked.model).toBe(config.frontierModel);
    expect(picked.reason).toBe("default_frontier");
  });

  it("shows cheap vs frontier on the same prompt via two decisions", () => {
    const split = { ...config, cheapModel: "cheap-id", frontierModel: "frontier-id" };
    const promptTurn = turn({});
    const cheap = pickModel(promptTurn, split);
    const frontier = pickModel(
      { ...promptTurn, kind: "architecture", difficulty: 3, difficultyLabel: "hard" },
      split,
    );
    expect(cheap.model).toBe("cheap-id");
    expect(frontier.model).toBe("frontier-id");
  });
});
