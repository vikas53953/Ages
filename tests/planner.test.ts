import { describe, expect, it } from "vitest";
import { planLocal } from "../src/planner.ts";

describe("planLocal", () => {
  it("lists the folder", () => {
    expect(planLocal("list files here")).toEqual({ tool: "read", path: "." });
  });

  it("reads a named file", () => {
    expect(planLocal("read README.md")).toEqual({ tool: "read", path: "README.md" });
  });

  it("greps from search phrasing", () => {
    expect(planLocal("search for runLoop")).toEqual({
      tool: "grep",
      pattern: "runLoop",
      path: ".",
    });
  });

  it("stays none when it cannot plan", () => {
    expect(planLocal("hello")).toEqual({ tool: "none" });
  });
});
