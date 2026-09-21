import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { mockJev } from "../src/jev/mock.ts";
import { runLoop } from "../src/loop.ts";
import { readPath } from "../src/tools/read.ts";

describe("mock-Jev loop", () => {
  it("uses real read and writes a receipt without calling OpenAI", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "gate-loop-"));
    await writeFile(path.join(cwd, "hello.txt"), "hi", "utf8");

    const receipt = await runLoop({
      prompt: "what files are in this folder?",
      cwd,
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => false,
      sessionId: "loop-mock",
      provider: "local",
      generate: async ({ tools, messages }) => {
        expect(messages.at(-1)?.content).toContain("files");
        const listing = await tools.read.execute!(
          { path: "." },
          {
            toolCallId: "t1",
            messages: [],
            abortSignal: new AbortController().signal,
            context: {},
          } as never,
        );
        return {
          text: `files:\n${listing}`,
          inputTokens: 12,
          outputTokens: 8,
        };
      },
    });

    expect(receipt.model).toBe(loadConfig().cheapModel);
    expect(receipt.routeReason).toBe("lookup+trivial/minor");
    expect(receipt.turn.source).toBe("mock");
    expect(receipt.tools[0]?.name).toBe("read");
    expect(receipt.tools[0]?.approved).toBe(true);
    expect(receipt.text).toContain("hello.txt");
    expect(await readPath(".", cwd)).toContain("hello.txt");

    const log = await readFile(
      path.join(cwd, ".harness", "receipts", "loop-mock.jsonl"),
      "utf8",
    );
    expect(log).toContain("lookup+trivial/minor");
    expect((await readdir(path.join(cwd, ".harness", "receipts"))).length).toBe(1);
  });

  it("uses the selected model instead of Jev cheap routing", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "gate-loop-pin-"));
    const receipt = await runLoop({
      prompt: "hello",
      cwd,
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => false,
      sessionId: "loop-pin",
      provider: "local",
      model: "glm-5.3",
      generate: async ({ model }) => {
        expect(model).toBe("glm-5.3");
        return { text: "hi", inputTokens: 1, outputTokens: 1 };
      },
    });
    expect(receipt.model).toBe("glm-5.3");
    expect(receipt.routeReason).toBe("selected");
  });
});
