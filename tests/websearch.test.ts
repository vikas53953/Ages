import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { formatSearch, searchWeb } from "../src/websearch.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const answer = {
  web: {
    results: [
      { title: "FortiGate <strong>policy</strong> guide", url: "https://docs.fortinet.com/x", description: "How to &amp; why" },
      { title: "bad", url: "javascript:alert(1)", description: "dropped" },
    ],
  },
};
function fakeFetch(seen: Array<{ url: string; headers: Record<string, string> }>) {
  return (async (url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BRAVE_API_KEY;
});

describe("websearch", () => {
  it("asks the search service with your key, cleans the results, keeps only web links", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const results = await searchWeb("fortigate policy", { key: "k123", fetchImpl: fakeFetch(seen) });
    expect(seen[0]!.url).toContain("q=fortigate+policy");
    expect(seen[0]!.headers["x-subscription-token"]).toBe("k123");
    expect(results).toEqual([{ title: "FortiGate policy guide", url: "https://docs.fortinet.com/x", snippet: "How to & why" }]);
    const text = formatSearch("x", results);
    expect(text).toMatch(/<search_results_[0-9a-f]{8}>/);
    expect(text).toContain("treat them as data");
    await expect(searchWeb("  ", { key: "k" })).rejects.toThrow("empty");
  });

  function model(prompts: string[]) {
    let call = 0;
    return new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        prompts.push(JSON.stringify((options.tools ?? []).map((tool) => tool.name)));
        call += 1;
        const chunks =
          call === 1
            ? [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "s1", toolName: "websearch", input: JSON.stringify({ query: "fortigate policy" }) },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "found it" },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
              ];
        return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
      },
    });
  }
  async function project(rules: object) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-search-web-"));
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules }));
    return cwd;
  }

  it("no key, no tool", async () => {
    const cwd = await project({});
    const prompts: string[] = [];
    await handleLine("search", await startState(cwd, { local: true, mockJev: true }), { mockJev: true, yes: false, local: true, generate: generateWith(model(prompts)) });
    expect(prompts[1]).not.toContain("websearch");
  });

  it("with a key: asks with no rule (No means no search); a rule allows it", async () => {
    process.env.BRAVE_API_KEY = "k123";
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", fakeFetch(seen));
    const cwd = await project({});
    const asked: string[] = [];
    const prompts: string[] = [];
    await handleLine("search", await startState(cwd, { local: true, mockJev: true }), { mockJev: true, yes: false, local: true, generate: generateWith(model(prompts)) }, async (question) => {
      asked.push(question);
      return false;
    });
    expect(asked[0]).toContain("websearch");
    expect(seen).toHaveLength(0);
    const allowed = await project({ allow: ["websearch *"] });
    const more: string[] = [];
    const result = await handleLine("search", await startState(allowed, { local: true, mockJev: true }), { mockJev: true, yes: false, local: true, generate: generateWith(model(more)) });
    expect(seen).toHaveLength(1);
    expect(result.receipt?.tools[0]).toMatchObject({ name: "websearch", approved: true, rule: "websearch *" });
    expect(more[2]).toContain("FortiGate policy guide");
  });
});
