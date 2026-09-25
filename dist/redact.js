/**
 * Secret-looking values are replaced before tool output reaches the model (a read of a config file, a grep hit,
 * a web page, an MCP result). Once a key is in the conversation it is sent to the model provider on every later
 * turn and saved in the session, so it is cut in the lock (gated.ts), which every Aegis tool result passes.
 *
 * Only well-known key formats and NAME=value settings with secret-sounding names are touched, so ordinary code is
 * left alone. It is a safety net, not a guarantee: rules (ask before reading .env, keys and certificates) come first.
 * Every pattern runs in linear time: tool output can be megabytes.
 */
const PATTERNS = [
    // A whole key block (END marker within 20,000 characters), or a BEGIN line with its base64 body (a cut read).
    // The body may not contain another BEGIN, so a text with many BEGIN lines and no END stays linear.
    { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:(?!-----BEGIN)[\s\S]){0,20000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g },
    { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:\r?\n[A-Za-z0-9+/=]{16,})+/g },
    { kind: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
    { kind: "api-key", re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|oc_sk_[A-Za-z0-9_-]{16,})/g },
    { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
    { kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];
/** Replaced keeping the part before the secret: "Bearer [redacted:…]", "postgres://user:[redacted:…]@host". */
const KEEPING = [
    { kind: "bearer-token", re: /(\bBearer[ \t]+)[A-Za-z0-9\-._~+/]{20,4096}=*/g },
    { kind: "basic-auth", re: /(\bBasic[ \t]+)[A-Za-z0-9+/]{16,4096}={0,2}/g },
    { kind: "url-password", re: /(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{0,200}:)[^\s@/]{3,1024}(?=@)/gi },
];
/** Name words that mark a secret (whole words between "_"): AWS_SECRET_ACCESS_KEY yes, MONKEY or KEYBOARD no. */
const SECRET_WORDS = new Set(["KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PWD", "PASSPHRASE", "CREDENTIAL", "CREDENTIALS"]);
/** For lower-case and camelCase names ("password", "apiKey", "client_secret"): plain "key" alone is too common. */
const SECRET_WORDS_LOWER = new Set(["password", "passwd", "pwd", "passphrase", "secret", "token", "apikey", "credential", "credentials"]);
const SECRET_PAIRS = new Set(["api key", "private key", "access key", "secret key", "client secret", "access token", "auth token"]);
/** Words that describe a secret rather than hold one: secretName, secretKeyRef, tokenLifetime, passwordMinLength. */
const DESCRIBING = new Set([
    "name", "names", "ref", "path", "file", "url", "id", "lifetime", "length", "type", "kind", "list", "store", "min", "max",
    "count", "field", "label", "header", "prefix", "expiry", "expires", "ttl", "mode", "policy", "provider", "format",
    "endpoint", "uri", "version", "server", "host", "port", "from", "reset", "hint", "pattern", "regex", "algorithm",
]);
/**
 * NAME=value / NAME: value / $name = value. The look-behind only lets a name start at a word start, which keeps
 * this linear and lets it match after a grep "file:12:" or a numbered read's "  12  " prefix. A quoted value may
 * hold spaces and other marks; an unquoted one ends at white space or code punctuation.
 */
const SETTING = /(?<![A-Za-z0-9_$])((?:\$env:|\$)?["']?[A-Za-z][A-Za-z0-9_-]{1,80}["']?)([ \t]*(?::=|=>|[=:])[ \t]*)(?:"([^"\n]{8,4096})"|'([^'\n]{8,4096})'|([^\s"'#,;`)\]}]{8,4096}))/g;
function secretName(raw) {
    const name = raw.replace(/^\$(?:env:)?/, "").replace(/["']/g, "");
    if (/^[A-Z0-9_]+$/.test(name)) {
        const words = name.split("_");
        if (words.includes("PUBLIC") || words.some((word) => DESCRIBING.has(word.toLowerCase()) && word !== "ID"))
            return false;
        return words.some((word) => SECRET_WORDS.has(word)) || name.endsWith("CONNECTION_STRING");
    }
    // camelCase, kebab-case, snake_case in lower case: split into words.
    const words = name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[\s_-]+/)
        .map((word) => word.toLowerCase())
        .filter(Boolean);
    if (words.includes("public") || words.some((word) => DESCRIBING.has(word)))
        return false;
    if (words.some((word) => SECRET_WORDS_LOWER.has(word)))
        return true;
    return words.some((word, index) => index > 0 && SECRET_PAIRS.has(`${words[index - 1]} ${word}`)) || words.join("") === "connectionstring";
}
/** Example values in .env.example and docs are not secrets (and the model needs to see them to copy the file). */
const PLACEHOLDER = /^(?:changeme|change[-_]me|replace[-_ ]?me|your[-_ ]|xxx|<|example|placeholder|dummy|todo)/i;
/**
 * Values that name something rather than being one: numbers, URLs, paths, variable references, code.
 * `code` = the value is followed by , ; ) — a struct/object literal or a call, where a bare word is a variable.
 */
function notAValue(value, name, quoted, code) {
    if (PLACEHOLDER.test(value))
        return true;
    if (!quoted) {
        // A variable or type, not a value: `password: PasswordField;`, `token: API_TOKEN,`, `secret: Promise<string>`.
        if (code && /^[A-Za-z_$][\w$]*(?:<.*>)?(?:\[\])?$/.test(value))
            return true;
        // Outside code (YAML, .properties, .env): a PascalCase type, a CONST_NAME or a camelCase word without digits.
        if (/[a-z]/.test(name.replace(/^\$(?:env:)?/, ""))) {
            if (/^[A-Z][a-z]+(?:[A-Z][a-z]+)*$/.test(value) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value))
                return true;
            if (/^[a-z]+(?:[A-Z][a-z]+)+$/.test(value))
                return true;
        }
        if (/[[\]<>{}]/.test(value) || /^[*!&]/.test(value))
            return true;
    }
    return (/^\d+(?:\.\d+)*(?:[-+][\w.]+)?$/.test(value) ||
        /^(?:https?:\/\/|\/|\.\.?[\\/]|~[\\/]|[A-Za-z]:[\\/]|\\\\|\$|%|process\.env|os\.environ|\[redacted:)/.test(value) ||
        (!quoted && value.includes("(")) ||
        /^[A-Za-z_]\w*(?:[?!]?\.[A-Za-z_]\w*)+$/.test(value) ||
        /^[\w.-]+\\[\w.\\-]+$/.test(value));
}
function redactAll(text) {
    let count = 0;
    let out = text;
    for (const pattern of PATTERNS) {
        out = out.replace(pattern.re, () => {
            count += 1;
            return `[redacted:${pattern.kind}]`;
        });
    }
    for (const pattern of KEEPING) {
        out = out.replace(pattern.re, (_match, keep) => {
            count += 1;
            return `${keep}[redacted:${pattern.kind}]`;
        });
    }
    out = out.replace(SETTING, (match, name, between, dq, sq, bare, offset, whole) => {
        const value = dq ?? sq ?? bare ?? "";
        const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
        const next = whole[offset + match.length] ?? "";
        if (!secretName(name) || notAValue(value, name, Boolean(quote), /[,;)]/.test(next)))
            return match;
        count += 1;
        return `${name}${between}${quote}[redacted:secret-value]${quote}`;
    });
    return { text: out, count };
}
/** Redact; if anything goes wrong, fail closed: the model gets a note, never the unfiltered text. */
export function redactSecrets(text) {
    try {
        return redactAll(text);
    }
    catch {
        return { text: "[Aegis could not check this output for secrets, so it is withheld.]", count: 1 };
    }
}
/** The placeholder, for tools that must not write it back into a file. */
export const REDACTED_MARK = "[redacted:";
