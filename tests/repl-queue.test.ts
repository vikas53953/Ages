import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { queuedLines } from "../src/repl.ts";

function fakeRl() {
  return new EventEmitter() as unknown as Parameters<typeof queuedLines>[0] & EventEmitter;
}

describe("queuedLines", () => {
  it("keeps lines that arrive while the consumer is busy", async () => {
    const rl = fakeRl();
    const next = queuedLines(rl);
    rl.emit("line", "/help");
    rl.emit("line", "/skills");
    rl.emit("line", "/exit");
    expect(await next()).toBe("/help");
    expect(await next()).toBe("/skills");
    expect(await next()).toBe("/exit");
  });

  it("returns null after close", async () => {
    const rl = fakeRl();
    const next = queuedLines(rl);
    const pending = next();
    rl.emit("close");
    expect(await pending).toBeNull();
  });
});
