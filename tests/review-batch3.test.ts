import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadContext } from "../src/context.ts";
import { redactSecrets } from "../src/redact.ts";
import { DEFAULT_SETTINGS, FLOOR_ASK, matchRule } from "../src/rules.ts";
import { grepPath, walkFiles } from "../src/tools/grep.ts";
import { readPath } from "../src/tools/read.ts";
import { searchInWorker } from "../src/tools/search.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const floor = () => ({ ...structuredClone(DEFAULT_SETTINGS), rules: { ...DEFAULT_SETTINGS.rules, ask: [...DEFAULT_SETTINGS.rules.ask, ...FLOOR_ASK] } });

describe("search cannot hang Aegis", () => {
  it("a catastrophic regex is stopped at the deadline instead of freezing the process", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-redos-"));
    await writeFile(path.join(cwd, "a.txt"), `${"a".repeat(40)}b\n`);
    const started = Date.now();
    const result = await searchInWorker({ kind: "grep", pattern: "(a+)+$", path: ".", cwd }, undefined, 1500);
    expect(result).toContain("stopped after");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it("normal searches work through the worker; stop ends one at once", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-worker-"));
    await writeFile(path.join(cwd, "a.txt"), "needle\n");
    expect(await searchInWorker({ kind: "grep", pattern: "needle", path: ".", cwd })).toBe("a.txt:1:needle");
    expect(await searchInWorker({ kind: "glob", pattern: "*.txt", path: ".", cwd })).toBe("a.txt");
    const abort = new AbortController();
    abort.abort();
    await expect(searchInWorker({ kind: "grep", pattern: "x", path: ".", cwd }, abort.signal)).rejects.toThrow("stopped");
  }, 20_000);

  it("a link back to a parent folder does not loop forever", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-loop-"));
    await mkdir(path.join(cwd, "src"));
    await writeFile(path.join(cwd, "src", "a.ts"), "x\n");
    try {
      await symlink(cwd, path.join(cwd, "self"), "junction");
      await symlink(cwd, path.join(cwd, "src", "up"), "junction");
    } catch {
      return;
    }
    const files = await walkFiles(cwd);
    expect(files.map((f) => f.relative)).toEqual(["src/a.ts"]);
  });
});

describe("secrets: grep is held to the same floor as read", () => {
  it("grep on a secrets file asks; grep over a folder skips them and says so", async () => {
    const settings = floor();
    for (const file of [".env", "config/.env.production", ".npmrc", "keys/deploy.pem", ".git-credentials", "gcp/credentials.json"]) {
      expect(matchRule(settings, "grep", { pattern: "x", path: file }, "/p")?.action, file).toBe("ask");
    }
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-grepsecret-"));
    await writeFile(path.join(cwd, ".env"), "DB_PASSWORD=hunter2hunter2\n");
    await writeFile(path.join(cwd, "app.ts"), "const PASSWORD_MIN = 8;\n");
    const out = await grepPath("PASSWORD", ".", cwd);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("app.ts:1:");
    expect(out).toContain("1 secrets file(s) such as .env were not searched");
  });
});

describe("redaction: review fixes", () => {
  it("catches values after grep and numbered-read prefixes", () => {
    expect(redactSecrets("docker-compose.yml:4:  POSTGRES_PASSWORD: supersecretpass").text).not.toContain("supersecretpass");
    expect(redactSecrets("   4  POSTGRES_PASSWORD: supersecretpass").text).not.toContain("supersecretpass");
    expect(redactSecrets("cfg.env-3-API_TOKEN=abcdef123456").text).not.toContain("abcdef123456");
  });

  it("leaves ordinary settings alone", () => {
    const code = [
      "TOKEN_TTL_MS: 3600000,",
      'TOKEN_ENDPOINT: "https://login.example.com/token",',
      "MAX_TOKENS_PER_MINUTE=100000000",
      "KEYBOARD_LAYOUT=us-international",
      "MONKEY=banana-lover",
      "PWD=/home/user/projects/app",
      "PUBLIC_KEY=MIIBIjANBgkqhkiG9w0BAQEF",
      "SECRET_KEY = settings.SECRET_KEY",
    ].join("\n");
    expect(redactSecrets(code)).toEqual({ text: code, count: 0 });
  });

  it("a README that only mentions a key header keeps the rest of the file", () => {
    const readme = "Keys start with -----BEGIN RSA PRIVATE KEY----- and\nthe rest of this README must stay.";
    expect(redactSecrets(readme).text).toBe(readme);
    const cut = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAAAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAI\n[cut]";
    expect(redactSecrets(cut).text).toBe("[redacted:private-key]\n[cut]");
  });

  it("runs in linear time on megabytes of blank lines and long upper-case runs", () => {
    const started = Date.now();
    redactSecrets("\n".repeat(2_000_000));
    redactSecrets("KEY".repeat(300_000));
    redactSecrets(`${" ".repeat(1_000_000)}\n`);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("other review fixes", () => {
  it("read with offset/limit is capped in characters too", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-readcap-"));
    await writeFile(path.join(cwd, "bundle.min.js"), "x".repeat(300_000));
    const out = await readPath("bundle.min.js", cwd, { offset: 1, limit: 1 });
    expect(out.length).toBeLessThan(81_000);
    expect(out).toContain("cut at 80,000 characters");
  });

  it("AGENTS.local.md linked out of the project is not loaded; loaded text is redacted", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "aegis-ctx-out-"));
    await writeFile(path.join(outside, "id_rsa"), "PRIVATE-STUFF");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-ctx-in-"));
    await writeFile(path.join(cwd, "AGENTS.md"), "Use pnpm.\nDEPLOY_TOKEN=abcdefgh12345678");
    process.env.AEGIS_HOME = await mkdtemp(path.join(os.tmpdir(), "aegis-ctx-home-"));
    try {
      await symlink(path.join(outside, "id_rsa"), path.join(cwd, "AGENTS.local.md"));
    } catch {
      // no link rights: the redaction half still runs
    }
    const context = await loadContext(cwd);
    expect(context).not.toContain("PRIVATE-STUFF");
    expect(context).toContain("Use pnpm.");
    expect(context).not.toContain("abcdefgh12345678");
    void readFile;
  });
});

describe("a redaction placeholder is never written back", () => {
  it("write and edit whose text carries [redacted:…] are refused before the lock", async () => {
    const { simulateReadableStream } = await import("ai");
    const { MockLanguageModelV4 } = await import("ai/test");
    const { generateWith } = await import("../src/loop.ts");
    const { handleLine, startState } = await import("../src/runtime.ts");
    const { settingsPath } = await import("../src/rules.ts");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-placeholder-"));
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { allow: ["write *"] } }));
    await writeFile(path.join(cwd, "cfg.txt"), "DB_PASSWORD=realvalue123\n");
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const prompts: string[] = [];
    let index = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        index += 1;
        const chunks =
          index === 1
            ? [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "w", toolName: "write", input: JSON.stringify({ path: "cfg.txt", contents: "DB_PASSWORD=[redacted:secret-value]\nNEW=1\n" }) },
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
    const state = await startState(cwd, { local: true, mockJev: true });
    await handleLine("add NEW", state, { mockJev: true, yes: false, local: true, generate: generateWith(model) });
    expect(await readFile(path.join(cwd, "cfg.txt"), "utf8")).toBe("DB_PASSWORD=realvalue123\n");
    expect(prompts[1]).toContain("Not written: the text contains an Aegis [redacted:");
  });
});
