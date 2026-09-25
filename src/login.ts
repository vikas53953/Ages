import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODEX_CREDENTIAL } from "./auth/codex.ts";
import { loadCredential, lockToUser } from "./auth/store.ts";
import { userAegisDir } from "./env.ts";

/** What /login can store, by the name you type. Saved to ~/.aegis/.env so every folder sees it. */
export const LOGIN_KEYS: Record<string, { env: string; label: string }> = {
  opencode: { env: "OPENCODE_API_KEY", label: "OpenCode Zen (chat models)" },
  openai: { env: "OPENAI_API_KEY", label: "OpenAI (fallback chat models)" },
  jev: { env: "TYPESAFE_API_KEY", label: "TypeSafe Jev (spend/danger scorer)" },
};

export function userEnvFile() {
  return path.join(userAegisDir(), ".env");
}

function readLines(file: string) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

/** Replace KEY=… in ~/.aegis/.env (or add it); undefined removes it. Other lines are kept as they were. */
export function writeUserKey(env: string, value: string | undefined) {
  const file = userEnvFile();
  const lines = readLines(file).filter((line) => !line.trim().startsWith(`${env}=`));
  while (lines.length && lines.at(-1) === "") lines.pop();
  if (value !== undefined) lines.push(`${env}=${value}`);
  mkdirSync(path.dirname(file), { recursive: true });
  // mode applies only to a new file: an existing .env is locked down explicitly as well.
  writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
  lockToUser(file);
  if (value === undefined) delete process.env[env];
  else process.env[env] = value;
  return file;
}

/** "sk-abc…wxyz" → "••••wxyz". Enough to recognise a key without showing it. */
export function maskKey(value: string) {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

/** Hide the key in "/login opencode sk-…" before the line is echoed or kept in input history. */
export function redactLogin(line: string) {
  const match = /^(\s*\/login\s+\S+\s+)(\S+)(.*)$/i.exec(line);
  return match ? `${match[1]}${maskKey(match[2]!)}${match[3]}` : line;
}

export function loginStatus() {
  const chatgpt = loadCredential(CODEX_CREDENTIAL);
  const rows = Object.entries(LOGIN_KEYS).map(([name, key]) => {
    const value = process.env[key.env];
    return `  ${name.padEnd(9)} ${value ? `set ${maskKey(value)}` : "not set"}   ${key.label}`;
  });
  return [
    "Sign-ins:",
    `  chatgpt   ${chatgpt ? `signed in${chatgpt.email ? ` as ${chatgpt.email}` : ""}` : "not signed in"}   ChatGPT plan (Codex models)`,
    "",
    "Keys (a project .env overrides these):",
    ...rows,
    "",
    "  /login chatgpt          sign in with your ChatGPT plan (browser: /login chatgpt browser)",
    `  /login opencode <key>   save a key to ${userEnvFile()}`,
    "  /logout opencode        remove it",
  ].join("\n");
}
