import { describe, expect, it } from "vitest";
import { parseLine } from "../src/commands.ts";
import { parseTaskArg } from "../src/plugins/delivery/index.ts";

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
    expect(parseLine("/task")).toEqual({ type: "unknown", name: "task" });
    expect(parseLine("/exit")).toEqual({ type: "exit" });
  });

  it("treats empty as a no-op", () => {
    expect(parseLine("   ")).toEqual({ type: "empty" });
  });

  it("sends /task words to the delivery plugin parser", () => {
    expect(parseTaskArg("")).toEqual({});
    expect(parseTaskArg("new")).toEqual({ action: "new" });
    expect(parseTaskArg("new subnet-calculator")).toEqual({
      action: "new",
      id: "subnet-calculator",
    });
    expect(parseTaskArg("confirm")).toEqual({ action: "confirm" });
    expect(parseTaskArg("confirm subnet-calculator abcd1234")).toEqual({
      action: "confirm",
      id: "subnet-calculator",
      fingerprint: "abcd1234",
    });
    expect(parseTaskArg("accept")).toEqual({ action: "accept" });
    expect(parseTaskArg("build")).toEqual({ action: "build" });
    expect(parseTaskArg("open")).toEqual({ action: "open" });
    expect(parseTaskArg("bogus")).toBeUndefined();
  });
});
