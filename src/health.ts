import { hasJevCredentials } from "./env.ts";
import type { JevMode } from "./rules.ts";
import type { JevHealth, Receipt } from "./types.ts";

/** Scorer (Jev) status for the footer and /status: off, mock, live, down (key present, not answering), blocked (no key). */
export function initialJevHealth(mockJev: boolean, mode: JevMode = "second-opinion"): JevHealth {
  if (mode === "off") return "off";
  if (mockJev) return "mock";
  return hasJevCredentials() ? "down" : "blocked";
}

export function jevHealthFromReceipt(mockJev: boolean, receipt: Receipt): JevHealth {
  if (receipt.turn.source === "off") return "off";
  if (mockJev) return "mock";
  if (!hasJevCredentials()) return "blocked";
  if (receipt.turn.source === "fail_closed") return "down";
  if (receipt.tools.some((tool) => tool.source === "fail_closed")) return "down";
  if (receipt.tools.some((tool) => tool.source === "agreement")) {
    return receipt.turn.source === "jev" ? "live" : receipt.turn.source === "mock" ? "mock" : "live";
  }
  if (receipt.turn.source === "jev") return "live";
  if (receipt.turn.source === "mock") return "mock";
  return "down";
}
