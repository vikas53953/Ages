import { describe, expect, it } from "vitest";
import { parseLine } from "../src/commands.ts";

describe("parseLine", () => {
  it("treats normal text as a prompt", () => {
    expect(parseLine("list files")).toEqual({ type: "prompt", text: "list files" });
  });

  it("parses slash commands", () => {
    expect(parseLine("/help")).toEqual({ type: "help" });
    expect(parseLine("/new")).toEqual({ type: "new" });
    expect(parseLine("/sessions")).toEqual({ type: "sessions" });
    expect(parseLine("/resume abc")).toEqual({ type: "resume", id: "abc" });
    expect(parseLine("/memory")).toEqual({ type: "memory", note: undefined });
    expect(parseLine("/memory use PowerShell")).toEqual({
      type: "memory",
      note: "use PowerShell",
    });
    expect(parseLine("/skills")).toEqual({ type: "skills" });
    expect(parseLine("/compact")).toEqual({ type: "compact" });
    expect(parseLine("/clear")).toEqual({ type: "clear" });
    expect(parseLine("/status")).toEqual({ type: "status" });
    expect(parseLine("/models")).toEqual({ type: "models" });
    expect(parseLine("/model")).toEqual({ type: "model", id: undefined });
    expect(parseLine("/model auto")).toEqual({ type: "model", id: "auto" });
    expect(parseLine("/model glm-5.3")).toEqual({ type: "model", id: "glm-5.3" });
    expect(parseLine("/task")).toEqual({ type: "task" });
    expect(parseLine("/task new")).toEqual({ type: "task", action: "new" });
    expect(parseLine("/task new subnet-calculator")).toEqual({
      type: "task",
      action: "new",
      id: "subnet-calculator",
    });
    expect(parseLine("/task confirm")).toEqual({ type: "task", action: "confirm" });
    expect(parseLine("/task confirm subnet-calculator abcd1234")).toEqual({
      type: "task",
      action: "confirm",
      id: "subnet-calculator",
      fingerprint: "abcd1234",
    });
    expect(parseLine("/task accept")).toEqual({ type: "task", action: "accept" });
    expect(parseLine("/task build")).toEqual({ type: "task", action: "build" });
    expect(parseLine("/task open")).toEqual({ type: "task", action: "open" });
    expect(parseLine("/exit")).toEqual({ type: "exit" });
  });

  it("treats empty as a no-op", () => {
    expect(parseLine("   ")).toEqual({ type: "empty" });
  });
});
