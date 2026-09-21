import { describe, expect, it } from "vitest";
import { hasChatKey, modelsFor, resolveProvider } from "../src/providers.ts";
import { loadConfig } from "../src/config.ts";

describe("resolveProvider", () => {
  it("uses OpenCode when that key is set", () => {
    expect(resolveProvider({ OPENCODE_API_KEY: "zen-key" })).toBe("opencode");
  });

  it("uses OpenAI only when OpenCode is absent", () => {
    expect(resolveProvider({ OPENAI_API_KEY: "sk" })).toBe("openai");
  });

  it("stays local with no chat key", () => {
    expect(resolveProvider({})).toBe("local");
    expect(hasChatKey({})).toBe(false);
  });

  it("maps OpenCode defaults off gpt model names", () => {
    const cheap = process.env.GATE_CHEAP_MODEL;
    const frontier = process.env.GATE_FRONTIER_MODEL;
    delete process.env.GATE_CHEAP_MODEL;
    delete process.env.GATE_FRONTIER_MODEL;
    try {
      const models = modelsFor("opencode", {
        ...loadConfig(),
        cheapModel: "gpt-4.1-mini",
        frontierModel: "gpt-4.1",
      });
      expect(models.cheap).toBe("glm-5.3-flash");
      expect(models.frontier).toBe("glm-5.3");
    } finally {
      if (cheap !== undefined) process.env.GATE_CHEAP_MODEL = cheap;
      if (frontier !== undefined) process.env.GATE_FRONTIER_MODEL = frontier;
    }
  });
});
