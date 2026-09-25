/**
 * Secret-looking values are replaced before tool output reaches the model (a read of a config file, a grep hit,
 * a web page, an MCP result). Once a key is in the conversation it is sent to the model provider on every later
 * turn and saved in the session, so it is cut in the lock (gated.ts), which every Aegis tool result passes.
 *
 * Only well-known key formats and NAME=value settings with secret-sounding names are touched, so ordinary code is
 * left alone. It is a safety net, not a guarantee: rules (ask before reading .env, keys and certificates) come first.
 * Every pattern runs in linear time: tool output can be megabytes.
 */

type Pattern = { kind: string; re: RegExp };

const PATTERNS: Pattern[] = [
  // A whole key block (END marker within 20,000 characters), or a BEGIN line with its base64 body (a cut read).
  { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g },
  { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:\r?\n[A-Za-z0-9+/=]{16,})+/g },
  { kind: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { kind: "api-key", re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|oc_sk_[A-Za-z0-9_-]{16,})/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

/** Name words that mark a secret (whole words between "_"): AWS_SECRET_ACCESS_KEY yes, MONKEY or KEYBOARD no. */
const SECRET_WORDS = new Set(["KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL", "CREDENTIALS"]);

/**
 * NAME=value / NAME: value with an upper-case name. The look-behind only lets a name start at a word start, which
 * keeps this linear and lets it match after a grep "file:12:" or a numbered read's "  12  " prefix.
 */
const SETTING = /(?<![A-Za-z0-9_.$])((?:\$env:)?[A-Z][A-Z0-9_]{1,80})([ \t]*[=:][ \t]*["']?)([^\s"'#,;]{8,})/g;

function secretName(name: string) {
  const words = name.replace(/^\$env:/, "").split("_");
  if (words.includes("PUBLIC")) return false;
  return words.some((word) => SECRET_WORDS.has(word)) || name.endsWith("CONNECTION_STRING");
}

/** Values that name something rather than being one: numbers, URLs, paths, variable references, code. */
function notAValue(value: string) {
  return (
    /^\d+(?:\.\d+)?$/.test(value) ||
    /^(?:https?:\/\/|\/|\.\/|\$|%|process\.env|os\.environ|\[redacted:)/.test(value) ||
    value.includes("(") ||
    /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value)
  );
}

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern.re, () => {
      count += 1;
      return `[redacted:${pattern.kind}]`;
    });
  }
  out = out.replace(SETTING, (match: string, name: string, between: string, value: string) => {
    if (!secretName(name) || notAValue(value)) return match;
    count += 1;
    return `${name}${between}[redacted:secret-value]`;
  });
  return { text: out, count };
}

/** The placeholder, for tools that must not write it back into a file. */
export const REDACTED_MARK = "[redacted:";
