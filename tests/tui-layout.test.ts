import { describe, expect, it } from "vitest";
import { APP_DIFFERENCE, APP_NAME, APP_TAGLINE } from "../src/brand.ts";
import {
  footerText,
  jevStatus,
  renderAssistantMessage,
  renderUserMessage,
  sanitizeText,
  stripAnsi,
  welcomeBanner,
  wrapLine,
} from "../src/tui-layout.ts";

describe("tui-layout", () => {
  it("wraps long lines to the terminal width", () => {
    expect(wrapLine("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("strips erase-screen sequences from untrusted text", () => {
    expect(sanitizeText("keep\x1b[2Jsecret")).toBe("keepsecret");
    const assistant = renderAssistantMessage("keep\x1b[2Jsecret", 40).join("\n");
    expect(assistant).toContain("keepsecret");
    expect(assistant).not.toContain("\x1b[2J");
  });

  it("keeps the header to two lines, not a welcome card", () => {
    const text = stripAnsi(
      welcomeBanner({
        name: APP_NAME,
        version: "0.1.0",
        tagline: APP_TAGLINE,
        difference: APP_DIFFERENCE,
      }),
    );
    expect(text).toContain("Aegis");
    expect(text).toContain("the agent you own");
    expect(text).toContain("Jev locks spend and danger");
    expect(text).not.toContain("Welcome back");
    expect(text).not.toContain("Tips for getting started");
  });

  it("marks your turn with ›, the reply as indent", () => {
    const user = renderUserMessage("list the files", 40);
    const assistant = renderAssistantMessage("README.md", 40);
    expect(user[0]).toContain("›");
    expect(user[0]).toContain("list the files");
    expect(assistant[0]).toMatch(/^\s+README.md/);
    expect(user[0]).not.toMatch(/^>/);
  });

  it("prints auto/pinned and jev mock|live|down|blocked in the footer", () => {
    expect(jevStatus(true, false)).toBe("mock");
    expect(jevStatus(false, false)).toBe("blocked");
    expect(jevStatus(false, true)).toBe("down");
    expect(jevStatus(false, true, true)).toBe("live");
    expect(
      footerText({
        modelMode: "auto",
        model: "glm-5.3",
        jev: "down",
        provider: "local",
      }),
    ).toBe("auto · jev down · local · task none · idle");
    expect(
      footerText({
        modelMode: "auto",
        model: "glm-5.3",
        jev: "live",
        provider: "opencode",
        busy: true,
        phase: "waiting for model",
        elapsedMs: 3200,
        task: "proposed",
      }),
    ).toBe("waiting for model  3s · auto · jev live · task proposed");
  });
});
