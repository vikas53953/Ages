import { describe, expect, it } from "vitest";
import {
  formatModelList,
  mergeCatalog,
  OPENCODE_MODELS,
  resolveModel,
} from "../src/catalog.ts";

describe("catalog", () => {
  it("lists the full OpenCode set", () => {
    const text = formatModelList("glm-5.3");
    expect(text).toContain("glm-5.3");
    expect(text).toContain("gpt-5.5");
    expect(text).toContain("claude-opus-5");
    expect(text).toContain("gemini-3.1-pro");
    expect(text).toContain("kimi-k2.7-code");
    expect(text).toMatch(/\* glm-5\.3\b/);
  });

  it("resolves exact and unique prefix ids", () => {
    expect(resolveModel("glm-5.3")).toEqual({ ok: true, id: "glm-5.3" });
    expect(resolveModel("opencode/kimi-k2.7-code")).toEqual({
      ok: true,
      id: "kimi-k2.7-code",
    });
    expect(resolveModel("gpt-6-astra").ok).toBe(true);
    expect(resolveModel("kimi").ok).toBe(false);
    expect(resolveModel("jev-1.13").ok).toBe(false);
  });

  it("merges live ids onto the known table", () => {
    const rows = mergeCatalog(["glm-5.3", "brand-new-zen-model"]);
    expect(rows.some((row) => row.id === "brand-new-zen-model")).toBe(true);
    expect(rows.some((row) => row.id === "gpt-5.5")).toBe(true);
    expect(rows.length).toBeGreaterThan(OPENCODE_MODELS.length);
  });
});
