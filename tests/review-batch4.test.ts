import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadContext } from "../src/context.ts";
import { hardDeny } from "../src/engines/claude-code.ts";
import { redactSecrets } from "../src/redact.ts";
import { DEFAULT_SETTINGS, FLOOR_ASK, globMatch, matchRule, type Settings } from "../src/rules.ts";
import { grepPath, walkFiles } from "../src/tools/grep.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

function settings(rules: Partial<Settings["rules"]> = {}): Settings {
  const base = structuredClone(DEFAULT_SETTINGS);
  return { ...base, rules: { deny: [...base.rules.deny, ...(rules.deny ?? [])], ask: [...base.rules.ask, ...FLOOR_ASK, ...(rules.ask ?? [])], allow: [...base.rules.allow, ...(rules.allow ?? [])] } };
}

describe("rules cannot be made to hang Aegis", () => {
  it("a wildcard-heavy rule against a long path, command or host stays fast", () => {
    const hostile = settings({ ask: ["read *a*a*a*a*a*a*a*a*a*a*b", "shell *x*x*x*x*x*x*x*x*y"], deny: ["webfetch *a*a*a*a*a*a*b.com"] });
    const started = Date.now();
    matchRule(hostile, "read", { path: "a".repeat(5000) }, "/p");
    matchRule(hostile, "shell", { command: "x".repeat(5000) }, "/p");
    matchRule(hostile, "webfetch", { url: `https://${"a".repeat(60)}.com/` }, "/p");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(globMatch("src/*.ts", "SRC/deep/a.ts")).toBe(true); // "*" crosses folders in rules, as before
    expect(globMatch("git push*", "git push origin")).toBe(true);
    expect(globMatch("a*b", "acb")).toBe(true);
    expect(globMatch("a*b", "acbc")).toBe(false);
  });

  it("an allow rule for a path tool never reaches outside the folder", () => {
    const s = settings({ allow: ["read *", "grep *", "glob *"] });
    expect(matchRule(s, "read", { path: "/etc/passwd" }, "/p")).toBeUndefined();
    expect(matchRule(s, "glob", { pattern: "*", path: "../other" }, "/p")).toBeUndefined();
    expect(matchRule(s, "read", { path: "src/a.ts" }, "/p")?.action).toBe("allow");
    expect(matchRule(s, "read", { path: ".harness/sessions/x/checkpoints/blobs/1" }, "/p")?.action).toBe("ask");
  });
});

describe("redaction: batch 4", () => {
  it("stays fast on thousands of BEGIN lines without END", () => {
    const started = Date.now();
    redactSecrets("-----BEGIN RSA PRIVATE KEY-----\n".repeat(100_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("catches JSON keys, lower-case yaml, Bearer tokens, URL passwords, connection strings and *_PWD", () => {
    const cases = [
      '{"API_KEY": "sk_live_abcdefghijklmnop"}',
      '"apiKey": "zyxwvutsrqponmlk"',
      "password: hunter2hunter2",
      "client_secret=abcd1234efgh5678",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
      "DATABASE_URL=postgres://admin:S3cretPw@db.internal/prod",
      "DB_CONNECTION_STRING=Server=x;User=sa;Password=hunter2!;",
      "DB_PWD=hunter2hunter2",
    ];
    for (const text of cases) {
      const out = redactSecrets(text).text;
      expect(out, text).toContain("[redacted:");
      for (const secret of ["sk_live_abcdefghijklmnop", "zyxwvutsrqponmlk", "hunter2hunter2", "abcd1234efgh5678", "abcdefghijklmnopqrstuvwxyz0123", "S3cretPw", "hunter2!"]) {
        expect(out, text).not.toContain(secret);
      }
    }
  });

  it("still leaves ordinary code alone", () => {
    const code = [
      "const token = getToken();",
      "  token: userToken,",
      "  password: string,",
      "secret: this.secret,",
      "const key = 'id';",
      "PWD=/home/user/projects/app",
      "MAX_TOKENS_PER_MINUTE=100000000",
    ].join("\n");
    expect(redactSecrets(code)).toEqual({ text: code, count: 0 });
  });
});

describe("other batch 4 fixes", () => {
  it("grep cuts huge lines and caps the whole result", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-grepcap-"));
    for (let i = 0; i < 20; i += 1) await writeFile(path.join(cwd, `min${i}.js`), `${"x".repeat(200_000)}needle${"y".repeat(200_000)}`);
    const out = await grepPath("needle", ".", cwd);
    expect(out.length).toBeLessThan(20_000);
    expect(out).toContain("needle");
  });

  it("AGENTS.md that is a link (e.g. to .env) is not loaded", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-ctxlink-"));
    process.env.AEGIS_HOME = await mkdtemp(path.join(os.tmpdir(), "aegis-ctxlink-home-"));
    await writeFile(path.join(cwd, ".env"), "DATABASE_URL=postgres://admin:S3cretPw@db/prod\n");
    try {
      await symlink(path.join(cwd, ".env"), path.join(cwd, "AGENTS.md"));
    } catch {
      return;
    }
    expect(await loadContext(cwd)).not.toContain("S3cretPw");
  });

  it("Claude Code: glob outside the project, or through a link that leads out, is refused", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "aegis-cc-out-"));
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-cc-in-"));
    expect(hardDeny("glob", { pattern: "*", path: outside }, cwd, [])).toContain("outside the project");
    try {
      await symlink(outside, path.join(cwd, "link"), "junction");
    } catch {
      return;
    }
    expect(hardDeny("read", { path: "link/id_rsa" }, cwd, [])).toContain("outside the project");
    expect(hardDeny("grep", { pattern: "x", path: "link" }, cwd, [])).toContain("outside the project");
  });

  it(".gitignore character classes work like git", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-ignclass-"));
    await mkdir(path.join(cwd, "d"));
    await writeFile(path.join(cwd, ".gitignore"), "[ab].txt\n");
    await writeFile(path.join(cwd, "a.txt"), "");
    await writeFile(path.join(cwd, "c.txt"), "");
    expect((await walkFiles(cwd)).map((f) => f.relative).sort()).toEqual([".gitignore", "c.txt"]);
  });
});

describe("redaction: batch 5 (code must survive, more secrets caught)", () => {
  it("leaves types, references, k8s secret names and descriptive settings alone, and keeps punctuation", () => {
    const code = [
      "  token: AccessToken;",
      "  password: PasswordField;",
      "  credentials: Credentials;",
      "  secret: Promise<string>;",
      "  token: Token<string>;",
      "  password: Option<String>,",
      "  token: API_TOKEN,",
      "  password: DEFAULT_PASSWORD",
      "  Password: password,",
      "connect(host=host, password=password)",
      "Client(credentials=credentials)",
      "  password: userpassword,",
      "secretName: tls-cert-secret",
      "secretName: db-credentials",
      '"TokenLifetime": "00:30:00"',
      '"token-list": "workspace:*"',
      "passwordMinLength: 12345678",
      "const t = { token: API_TOKEN, password: X };",
    ].join("\n");
    expect(redactSecrets(code).text).toBe(code);
  });

  it("catches dotted keys, := and URLs with an empty user", () => {
    for (const text of [
      "spring.datasource.password=hunter2hunter2",
      "this.password = 'hunter2hunter2'",
      "PASSWORD := hunter2hunter2",
      "redis://:hunter2hunter2@cache:6379",
      "  apiKey: \"zyxwvutsrqponmlk\",",
    ]) {
      const out = redactSecrets(text).text;
      expect(out, text).not.toContain("hunter2hunter2");
      expect(out, text).not.toContain("zyxwvutsrqponmlk");
    }
    expect(redactSecrets('  apiKey: "zyxwvutsrqponmlk",').text).toBe('  apiKey: "[redacted:secret-value]",');
  });
});

describe("rule and target size limits", () => {
  it("a rule over 512 characters makes the file unreadable (fail safe); a huge target is never allowed", async () => {
    const { loadSettingsSafe, settingsPath } = await import("../src/rules.ts");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-longrule-"));
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ rules: { ask: [`read *${"a".repeat(600)}`] } }));
    const loaded = loadSettingsSafe(cwd);
    expect(loaded.error).toContain("longer than 512");
    expect(loaded.settings.rules.allow).toEqual([]);
    const s = settings({ allow: ["shell echo *"] });
    expect(matchRule(s, "shell", { command: `echo ${"x".repeat(40_000)}` }, cwd)).toBeUndefined();
    expect(matchRule(s, "shell", { command: "echo hi" }, cwd)?.action).toBe("allow");
  });
});

describe("redaction: batch 6", () => {
  it("catches kebab keys, plain YAML words, quoted values with spaces, Basic auth and PowerShell variables", () => {
    for (const [text, secret] of [
      ["api-key: Sup3rS3cret!Pw", "Sup3rS3cret!Pw"],
      ["x-api-key: Sup3rS3cret!Pw", "Sup3rS3cret!Pw"],
      ["secretKey: Sup3rS3cret9", "Sup3rS3cret9"],
      ["apiKey: SUPERSECRETVALUE", "SUPERSECRETVALUE"],
      ["password: correcthorsebatterystaple", "correcthorsebatterystaple"],
      ['PASSWORD="Sup3r S3cret!"', "Sup3r S3cret!"],
      ['PASSWORD="Sup3r#S3cret!"', "Sup3r#S3cret!"],
      ["Authorization: Basic dXNlcjpTdXAzclMzY3JldCFQdw==", "dXNlcjpTdXAzclMzY3JldCFQdw"],
      ['$password = "Sup3rS3cret!Pw"', "Sup3rS3cret!Pw"],
    ]) {
      expect(redactSecrets(text!).text, text).not.toContain(secret);
    }
  });

  it("leaves code, paths and placeholders alone", () => {
    const code = [
      "  token: session?.token,",
      "PRIVATE_KEY=C:\\certs\\server.key",
      "PRIVATE_KEY=~/.ssh/id_rsa",
      "  password: *db_password",
      "  secret: !isPublic,",
      "password_server: 192.168.1.100",
      "token_version: 1.2.3-beta.1",
      "SECRET_KEY=your-secret-key-here",
      "API_TOKEN=replace-me-please",
      "DB_PASSWORD=changeme123",
    ].join("\n");
    expect(redactSecrets(code).text).toBe(code);
  });
});

describe("always-allow never writes a rule that would break your settings", () => {
  it("a very long command is not offered as an 'always' rule, and saving one is refused", async () => {
    const { suggestAllowRule, saveAllowRule } = await import("../src/rules.ts");
    const long = `npm install ${Array.from({ length: 80 }, (_, i) => `@scope/package-${i}`).join(" ")}`;
    expect(suggestAllowRule("shell", { command: long }, undefined)).toBeUndefined();
    expect(suggestAllowRule("shell", { command: "npm test" }, undefined)).toBe("shell npm test");
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-longalways-"));
    process.env.AEGIS_HOME = await mkdtemp(path.join(os.tmpdir(), "aegis-longalways-home-"));
    expect(() => saveAllowRule(cwd, `shell ${long}`)).toThrow("longer than 512");
  });
});

describe("redaction: batch 7", () => {
  it("catches passwords inside connection strings (quoted or on their own line) and .npmrc tokens", () => {
    for (const [text, secret] of [
      ['{"ConnectionStrings": {"DefaultConnection": "Server=db;User Id=sa;Password=Sup3rS3cret9;Encrypt=true"}}', "Sup3rS3cret9"],
      ['"Default": "User=sa;Password=hunter2hunter2"', "hunter2hunter2"],
      ["Server=db;User Id=sa;Password=Sup3rS3cret9;Encrypt=true", "Sup3rS3cret9"],
      ["//registry.npmjs.org/:_authToken=npm_abcdefghijklmnop1234", "npm_abcdefghijklmnop1234"],
      ["//npm.pkg.github.com/:_password=aGVsbG8gd29ybGQ=", "aGVsbG8gd29ybGQ="],
      ["_auth=dXNlcjpwYXNzd29yZDEyMw==", "dXNlcjpwYXNzd29yZDEyMw=="],
      ["{password: hunter2hunter2, user: x}", "hunter2hunter2"],
    ]) {
      expect(redactSecrets(text!).text, text).not.toContain(secret);
    }
  });

  it("leaves more everyday code alone", () => {
    const code = [
      "const o = {",
      "  password: password",
      "}",
      "connect(",
      "  password=db_password",
      ")",
      "const p = { password: password };",
      "  password: undefined,",
      "  credentials: credentials ?? defaultCredentials,",
      "  return { ...x, token: refreshed };",
      "fetch(url, { credentials: 'same-origin' })",
      "  password: user.password!,",
    ].join("\n");
    expect(redactSecrets(code).text).toBe(code);
  });
});
