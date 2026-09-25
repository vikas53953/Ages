import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { findMentions } from "../src/mentions.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
function answering(prompts: string[]) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
          ] as never[],
        }),
      };
    },
  });
}

async function project(rules: object = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-mention-"));
  await mkdir(path.join(cwd, ".aegis"));
  await mkdir(path.join(cwd, "src"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules }));
  await writeFile(path.join(cwd, "src", "loop.ts"), "export const LOOP_MARKER = 1;\n");
  await writeFile(path.join(cwd, ".env"), "SECRET_TOKEN=abc\n");
  return cwd;
}

describe("@file mentions", () => {
  it("only paths that exist inside the folder count; emails and outside paths stay text", async () => {
    const cwd = await project();
    expect(findMentions("see @src/loop.ts, mail me@example.com, and @../etc/passwd or @nope.ts", cwd)).toEqual(["src/loop.ts"]);
    expect(findMentions("@src/ and @src/loop.ts and @src/loop.ts", cwd)).toEqual(["src/", "src/loop.ts"]);
  });

  it("attaches the file through the lock; a deny rule keeps it out", async () => {
    const cwd = await project({ deny: ["read .env"] });
    const state = await startState(cwd, { local: true, mockJev: true });
    const prompts: string[] = [];
    const result = await handleLine("explain @src/loop.ts and @.env", state, {
      mockJev: true,
      yes: false,
      local: true,
      generate: generateWith(answering(prompts)),
    });
    expect(prompts[0]).toContain("LOOP_MARKER");
    expect(prompts[0]).not.toContain("SECRET_TOKEN");
    expect(prompts[0]).toContain("@.env was not attached");
    expect(result.receipt?.tools.slice(0, 2).map((t) => [t.name, t.approved, t.rule])).toEqual([
      ["read", true, "read *"],
      ["read", false, "read .env"],
    ]);
  });
});
