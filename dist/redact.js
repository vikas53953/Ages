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
const SETTING = /(?<![A-Za-z0-9_$])((?:\$env:|\$)?["']?[A-Za-z_][A-Za-z0-9_-]{1,80}["']?)([ \t]*(?::=|=>|[=:])[ \t]*)(?:"([^"\n]{8,4096})"|'([^'\n]{8,4096})'|([^\s"'#,;`)\]}]{8,4096}))/g;
function secretName(raw) {
    const name = raw.replace(/^\$(?:env:)?/, "").replace(/["']/g, "").replace(/^_+/, "");
    // .npmrc: //registry/:_auth=<base64 user:password>
    if (/^_auth$/i.test(raw.replace(/["']/g, "")))
        return true;
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
/**
 * Is the value followed by code (so a bare word is a variable)? `,` `)` `}` `??` `||` after it, or a `;` ending
 * a statement: after a ":" pair, or `name = value;` with spaces, alone on its line. `Password=Secret1;` (no
 * spaces) and a `;` after an earlier pair on the line (`Server=x;Password=Secret1;`) are connection strings.
 * `after` is a short look-ahead and `before` the line up to the name, so each check is bounded.
 */
function codeAfter(after, between, before) {
    if (/^\s*(?:[,)}]|\?\?|\|\||&&|!)/.test(after))
        return true;
    if (!after.startsWith(";"))
        return false;
    if (between.includes(":"))
        return true;
    return /^;[ \t]*(?:\r?\n|$)/.test(after) && /\s/.test(between) && !/[;=]/.test(before);
}
/** Example values in .env.example and docs are not secrets (and the model needs to see them to copy the file). */
const PLACEHOLDER = /^(?:changeme|change[-_]me|replace[-_ ]?me|your[-_ ]|xxx|<|example|placeholder|dummy|todo)/i;
/** Words that are never a secret value: keywords, and fetch's credentials modes. */
const KEYWORDS = new Set(["undefined", "null", "true", "false", "none", "nil", "same-origin", "include", "omit", "required", "optional"]);
/**
 * Values that name something rather than being one: numbers, URLs, paths, variable references, code.
 * `code` = the value is followed by , ; ) — a struct/object literal or a call, where a bare word is a variable.
 */
function notAValue(value, name, quoted, code, connection = false) {
    if (PLACEHOLDER.test(value) || KEYWORDS.has(value.toLowerCase()))
        return true;
    const bareName = name.replace(/^\$(?:env:)?/, "").replace(/["']/g, "");
    if (!quoted) {
        // `password: password`, `password=db_password`: the same word, or a snake_case variable, is a reference.
        if (value.toLowerCase() === bareName.toLowerCase())
            return true;
        // (Not for .npmrc's _auth/_authToken, which are always values.)
        if (/[a-z]/.test(bareName) && !/^_auth/i.test(bareName) && /^[a-z]+(?:_[a-z]+)+$/.test(value))
            return true;
    }
    if (!quoted) {
        // A variable or type, not a value: `password: PasswordField;`, `token: API_TOKEN,`, `secret: Promise<string>`.
        // (A lower-case word with a digit in it, like hunter2hunter2, is a value even in code.)
        const lowerWithDigit = /^[a-z0-9_]+$/.test(value) && /\d/.test(value) && /[a-z]/.test(value);
        if (code && !lowerWithDigit && /^[A-Za-z_$][\w$]*(?:<.*>)?(?:\[\])?$/.test(value))
            return true;
        // Outside code (YAML, .properties, .env): a PascalCase type, a CONST_NAME or a camelCase word without digits.
        // (Inside a connection string, "Server=x;Password=MySecretPass", a word is the value itself.)
        if (!connection && /[a-z]/.test(name.replace(/^\$(?:env:)?/, ""))) {
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
        /^[A-Za-z_]\w*(?:[?!]?\.[A-Za-z_]\w*)+!?$/.test(value) ||
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
    // NAME=value pairs, walked one by one: a match that is not a secret gives back its value, so an inner pair
    // (the Password=… inside a quoted connection string) is still looked at.
    let result = "";
    let last = 0;
    SETTING.lastIndex = 0;
    for (let found = SETTING.exec(out); found; found = SETTING.exec(out)) {
        const [match, name = "", between = "", dq, sq, bare] = found;
        const value = dq ?? sq ?? bare ?? "";
        const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
        // A short window on each side, never the rest of the line: a one-line file with many pairs stays linear.
        const end = found.index + match.length;
        const after = out.slice(end, end + 64);
        const near = out.slice(Math.max(0, found.index - 256), found.index);
        const before = near.slice(near.lastIndexOf("\n") + 1);
        if (secretName(name) && !notAValue(value, name, Boolean(quote), codeAfter(after, between, before), /;\s*$/.test(before) && !between.includes(":"))) {
            count += 1;
            result += `${out.slice(last, found.index)}${name}${between}${quote}[redacted:secret-value]${quote}`;
            last = found.index + match.length;
        }
        else {
            // Not a secret: continue right after the separator, so the value itself is searched too.
            SETTING.lastIndex = found.index + name.length + between.length + (quote ? 1 : 0);
        }
    }
    out = result + out.slice(last);
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
