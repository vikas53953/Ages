/**
 * Secret-looking values are replaced before tool output reaches the model (a read of a config file, a grep hit,
 * a web page, an MCP result). Once a key is in the conversation it is sent to the model provider on every later
 * turn and saved in the session, so it is cut here, at the one place all Aegis tool output passes.
 *
 * Only well-known key formats and KEY=value lines with secret-sounding names are touched, so ordinary code is
 * left alone. It is a safety net, not a guarantee: rules (ask before reading .env, keys and certificates) come first.
 */

type Pattern = { kind: string; re: RegExp; keep?: (match: string, ...groups: string[]) => string };

const PATTERNS: Pattern[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { kind: "api-key", re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|oc_sk_[A-Za-z0-9_-]{16,})/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    // .env style: FOO_API_KEY=..., export DB_PASSWORD="...". Upper-case names only, so code such as
    // `apiKey: process.env.OPENAI_API_KEY` is left alone; the name is kept so the model knows the setting exists.
    kind: "secret-value",
    re: /^(\s*(?:export\s+|\$env:)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|CONNECTION_STRING)[A-Z0-9_]*\s*[=:]\s*["']?)([^\s"'#]{8,})/gm,
    keep: (match, prefix, value) => (/^(\$|process\.env|os\.environ|%)|\(/.test(value!) ? match : prefix!),
  },
];

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern.re, (match: string, ...groups: string[]) => {
      if (match.includes("[redacted:")) return match;
      const kept = pattern.keep ? pattern.keep(match, ...groups) : "";
      if (kept === match) return match; // a reference such as $env:X or process.env.X, not a value
      count += 1;
      return `${kept}[redacted:${pattern.kind}]`;
    });
  }
  return { text: out, count };
}
