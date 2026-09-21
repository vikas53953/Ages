import { describe, expect, it } from "vitest";
import { formatReceipt, millicentsFromUsage } from "../src/receipt.ts";
import type { Receipt } from "../src/types.ts";

describe("receipt", () => {
  it("prints model, kind odds, and millicents", () => {
    const receipt: Receipt = {
      sessionId: "t",
      prompt: "list files",
      model: "gpt-4.1-mini",
      routeReason: "lookup+trivial/minor",
      turn: {
        kind: "lookup",
        difficulty: 0,
        difficultyLabel: "trivial",
        needsRepoWide: 0.1,
        confidence: 0.9,
        probabilities: { kind: { lookup: 0.91, edit: 0.06, architecture: 0.03 } },
        source: "jev",
      },
      tools: [
        {
          name: "read",
          class: "read_only",
          dataLoss: 0.04,
          confidence: 0.8,
          action: "auto",
          approved: true,
        },
      ],
      ms: 120,
      millicents: 3,
      text: "hello.txt",
    };
    const printed = formatReceipt(receipt);
    expect(printed).toContain("gpt-4.1-mini");
    expect(printed).toContain("lookup=0.91");
    expect(printed).toContain("via jev");
    expect(printed).toContain("unpriced");
    expect(millicentsFromUsage(1000, 500)).toBe(0);
  });
});
