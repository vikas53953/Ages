import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { runGatedTool } from "../src/gated.ts";
import { redactSecrets } from "../src/redact.ts";
import { DEFAULT_SETTINGS, loadSettings, matchRule, settingsPath } from "../src/rules.ts";

describe("secret redaction", () => {
  it("cuts well-known key formats and .env values, keeping the names", () => {
    const text = [
      "AWS=AKIAIOSFODNN7EXAMPLE",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "export DB_PASSWORD=\"hunter2hunter2\"",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "oc_sk_ABCDEFGHIJKLMNOPQRS",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ].join("\n");
    const { text: out, count } = redactSecrets(text);
    expect(count).toBe(7);
    for (const secret of ["AKIAIOSFODNN7EXAMPLE", "abcdefghijklmnop", "hunter2hunter2", "ghp_abc", "oc_sk_ABC", "b3BlbnNzaC1", "dozjgNry"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("OPENAI_API_KEY=[redacted:");
    expect(out).toContain("export DB_PASSWORD=\"[redacted:secret-value]");
  });

  it("leaves ordinary code alone", () => {
    const code = [
      "const apiKey = process.env.OPENAI_API_KEY;",
      "  apiKey: process.env.OPENAI_API_KEY,",
      "OPENAI_API_KEY=$env:OPENAI_API_KEY",
      "function getToken() { return token; }",
      "MAX_TOKENS=4096",
      "const sk = 'sk-short';",
    ].join("\n");
    expect(redactSecrets(code)).toEqual({ text: code, count: 0 });
  });

  it("the lock cuts secrets from tool output before the model sees them, and says so", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-redact-"));
    const run = await runGatedTool({
      name: "read",
      args: { path: "config.txt" },
      cwd,
      config: loadConfig(),
      settings: { ...structuredClone(DEFAULT_SETTINGS), jev: { mode: "off" } },
      confirm: async () => false,
      execute: async () => "region=eu\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
    });
    expect(run.output).not.toContain("wJalrXUtnFEMI");
    expect(run.output).toContain("region=eu");
    expect(run.output).toContain("redacted 1 secret-looking value");
    expect(run.record.redacted).toBe(1);
  });
});

describe("secret files are asked about, whatever the rules allow", () => {
  it(".env, keys, certificates and ssh folders ask, even with allow read *", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-secretfloor-"));
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ rules: { allow: ["read *"] } }));
    const settings = loadSettings(cwd);
    for (const file of [".env", "api/.env.local", "certs/server.pem", "tls.key", "cert.pfx", "home/.ssh/id_ed25519", ".aws/credentials"]) {
      expect(matchRule(settings, "read", { path: file }, cwd)?.action, file).toBe("ask");
    }
    for (const file of ["src/app.ts", "README.md", "src/keyboard.ts"]) {
      expect(matchRule(settings, "read", { path: file }, cwd)?.action, file).toBe("allow");
    }
  });
});

describe("redaction: review fixes (6e05349)", () => {
  it("the last pair of a connection string, and a bare NAME=value; line, are redacted", () => {
    for (const text of ["Data Source=x;Password=Secret123;", "DB_PASSWORD=Secret123;", "Password=MyS3cretPass;", "Server=x;Password=MySecretPass;"]) {
      expect(redactSecrets(text).text, text).toContain("[redacted:secret-value]");
    }
  });

  it("code statements are still left alone", () => {
    for (const text of ["password = userPassword;", "const token = readToken;", "  secret: SecretField;"]) {
      expect(redactSecrets(text).text, text).not.toContain("[redacted:");
    }
  });

  it(".npmrc _authToken is always a value", () => {
    expect(redactSecrets("//registry.npmjs.org/:_authToken=abcd_efgh_ijkl").text).toContain("[redacted:secret-value]");
  });

  it("stays linear on one long line with many pairs", () => {
    const line = "password=hunter2hunter2 ".repeat(180_000);
    const start = Date.now();
    const out = redactSecrets(line);
    expect(out.count).toBe(180_000);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
