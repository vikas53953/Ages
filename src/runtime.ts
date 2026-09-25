import { loadEnv, hasJevCredentials } from "./env.ts";
import { formatReceipt, localGenerate, runLoop, type GenerateFn, type TurnEvent } from "./loop.ts";
import { formatChat, formatTokenLine } from "./receipt.ts";
import { modelsFor, resolveProvider, type ChatProvider } from "./providers.ts";
import { HELP, parseLine } from "./commands.ts";
import { addMemory, loadMemory } from "./memory.ts";
import { loadSkills } from "./skills.ts";
import { loadContext } from "./context.ts";
import { compactSession, loadSummary, modelSummarizer, needsCompaction, type Summarizer } from "./compact.ts";
import { buildSystemPrompt } from "./system.ts";
import { currentCatalog, formatModelList, refreshCatalog } from "./catalog.ts";
import { clearPinnedModel, defaultModelId, loadPinnedModel, setPinnedModel } from "./model-pin.ts";
import {
  createSession,
  listSessions,
  loadMessages,
  loadOrCreateSession,
  switchSession,
  recentSessions,
  appendMessage,
  appendMessages,
  capToolResults,
  type SessionMeta,
} from "./session.ts";
import type { ConfirmFn, JevHealth, Receipt, TaskPermission } from "./types.ts";
import { loadSettingsSafe, saveThinking, settingsPath, thinkingOf } from "./rules.ts";
import { parseThinkingDisplay, parseThinkingLevel } from "./thinking.ts";
import { THEME_NAMES, parseTheme, saveUserTheme, themeName } from "./theme.ts";
import type { AegisPlugin, CommandContext } from "./plugin-api.ts";
import { initialJevHealth, jevHealthFromReceipt } from "./health.ts";
import { runPowerShell } from "./tools/fs.ts";
import { LOGIN_KEYS, loginStatus, maskKey, writeUserKey } from "./login.ts";
import { APP_NAME, APP_VERSION, displayUser } from "./brand.ts";
import { loadConfig } from "./config.ts";
import type { WelcomeInfo } from "./welcome.ts";

export { initialJevHealth, jevHealthFromReceipt } from "./health.ts";
import { KNOWN_PLUGINS, loadPlugins } from "./plugins/index.ts";

export type RunOpts = {
  mockJev: boolean;
  yes: boolean;
  local?: boolean;
  model?: string;
  abortSignal?: AbortSignal;
  generate?: GenerateFn;
  /** Tests swap the compaction summarizer here. */
  summarize?: Summarizer;
  /** Start a fresh session instead of continuing the last one (the CLI default; `aegis -c` continues). */
  newSession?: boolean;
};

export type AppState = {
  cwd: string;
  session: SessionMeta;
  provider: ChatProvider;
  model: string;
  modelMode: "auto" | "pinned";
  jevHealth: JevHealth;
  taskPermission: TaskPermission;
  /** Layer-1 plugins loaded from .aegis/settings.json. */
  plugins: AegisPlugin[];
  /** Plugin names in settings that Aegis does not know. */
  unknownPlugins: string[];
  /** Tokens used since this session was opened in this run. */
  sessionTokens: { input: number; output: number };
};

export type HandleResult = {
  exit?: boolean;
  output: string;
  notice?: string;
  session: SessionMeta;
  receipt?: Receipt;
  chat?: "keep" | "reset" | "reload";
};

export async function startState(
  cwd: string,
  opts: { local?: boolean; model?: string; mockJev?: boolean; newSession?: boolean },
): Promise<AppState> {
  const session = opts.newSession ? await createSession(cwd) : await loadOrCreateSession(cwd);
  const provider = opts.local ? "local" : resolveProvider();
  const config = loadEnv(cwd);
  await refreshCatalog();
  const pin = await loadPinnedModel(cwd);
  const pinned = defaultModelId({
    pin,
    override: opts.model,
    provider,
    config,
  });
  const settings = loadSettingsSafe(cwd).settings;
  const { plugins, unknown } = loadPlugins(settings.plugins, { mockJev: opts.mockJev });
  const jevHealth = plugins.some((plugin) => plugin.scorer)
    ? initialJevHealth(opts.mockJev === true, settings.jev.mode)
    : "off";
  for (const plugin of plugins) await plugin.onSessionStart?.(cwd);
  const permission = await pluginTaskPermission(plugins, cwd);
  const base = {
    cwd,
    session,
    provider,
    jevHealth,
    taskPermission: permission,
    plugins,
    unknownPlugins: unknown,
    sessionTokens: { input: 0, output: 0 },
  };
  if (pinned) return { ...base, model: pinned, modelMode: "pinned" };
  return { ...base, model: "auto", modelMode: "auto" };
}

async function pluginTaskPermission(plugins: AegisPlugin[], cwd: string): Promise<TaskPermission> {
  for (const plugin of plugins) {
    if (plugin.taskPermission) return plugin.taskPermission(cwd);
  }
  return "untracked";
}

/** Everything the welcome screen shows, read fresh (after /new, /login, /jev it changes). */
export async function welcomeInfo(state: AppState): Promise<WelcomeInfo> {
  const settings = loadSettingsSafe(state.cwd).settings;
  const config = loadConfig(state.cwd);
  const models = modelsFor(state.provider, config);
  return {
    name: APP_NAME,
    version: APP_VERSION,
    user: displayUser(),
    model: state.modelMode === "pinned" ? `${state.model} (pinned)` : `auto: ${models.cheap} / ${models.frontier}`,
    provider: state.provider === "opencode" ? "OpenCode Zen" : state.provider === "openai" ? "OpenAI" : "local, no key",
    cwd: state.cwd,
    jevMode: state.plugins.some((plugin) => plugin.scorer) ? settings.jev.mode : "not loaded",
    jevHealth: state.jevHealth,
    rules: {
      deny: settings.rules.deny.length,
      ask: settings.rules.ask.length,
      allow: settings.rules.allow.length,
    },
    plugins: state.plugins.map((plugin) => plugin.name),
    recent: await recentSessions(state.cwd, 3, state.session.id),
    hasChatKey: state.provider !== "local",
    thinking: (() => {
      const current = thinkingOf(settings);
      return `${current.level} · ${current.display === "fold" ? "folded" : current.display === "show" ? "shown" : "hidden"}`;
    })(),
  };
}

/** Entries for the /model picker: "auto" first, then the live catalogue grouped by provider. */
export function modelChoices(state: AppState) {
  const config = loadConfig(state.cwd);
  const models = modelsFor(state.provider, config);
  const rows = currentCatalog().map((entry) => ({
    id: entry.id,
    group: entry.group,
    note:
      entry.id === models.frontier
        ? `${entry.name} · default frontier`
        : entry.id === models.cheap
          ? `${entry.name} · default cheap`
          : entry.name,
  }));
  const defaults = rows.filter((row) => row.id === models.frontier || row.id === models.cheap);
  return [
    { id: "auto", group: "Aegis", note: `Jev picks ${models.cheap} or ${models.frontier} each turn` },
    ...defaults.map((row) => ({ ...row, group: "Defaults" })),
    ...rows.filter((row) => !defaults.includes(row)),
  ];
}

/** Text every enabled plugin adds to the system prompt (context:assemble). */
async function pluginPrompts(plugins: AegisPlugin[], cwd: string, sessionId: string) {
  const parts: string[] = [];
  for (const plugin of plugins) {
    const text = await plugin.systemPrompt?.({ cwd, sessionId });
    if (text) parts.push(text);
  }
  return parts;
}

/** The cheap chat model writes compaction summaries. Local mode has no model, so the extractive summary is used. */
function summarizerFor(opts: RunOpts, provider: ChatProvider, config: ReturnType<typeof loadEnv>): Summarizer | undefined {
  if (opts.summarize) return opts.summarize;
  if (opts.local || provider === "local") return undefined;
  return modelSummarizer(modelsFor(provider, config).cheap);
}

export async function runPrompt(
  prompt: string,
  state: AppState,
  opts: RunOpts,
  confirm: ConfirmFn,
  onEvent?: (event: TurnEvent) => void,
): Promise<{ output: string; notice?: string; session: SessionMeta; receipt?: Receipt }> {
  const config = loadEnv(state.cwd);
  const provider = opts.local ? "local" : resolveProvider();
  const useLocal = opts.local === true || provider === "local";
  const loadedSettings = loadSettingsSafe(state.cwd);
  const hasScorer = state.plugins.some((plugin) => plugin.scorer);
  const notice = [
    useLocal ? "Chat is local (no OpenCode key). I can list, read, and search." : "",
    loadedSettings.error
      ? `Settings unreadable (${loadedSettings.error}). Jev is off and allow rules are ignored until you fix ${settingsPath(state.cwd)}.`
      : "",
    hasScorer && !opts.mockJev && !hasJevCredentials() && loadedSettings.settings.jev.mode !== "off"
      ? "Jev has no key. Rules still apply; anything Jev would score asks you instead. /jev off hides this."
      : "",
    state.unknownPlugins.length
      ? `Unknown plugins in settings: ${state.unknownPlugins.join(", ")}. Known: ${KNOWN_PLUGINS.join(", ")}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n") || undefined;
  const session = await loadOrCreateSession(state.cwd);
  let history = await loadMessages(state.cwd, session.id);
  let compacted = "";
  if (needsCompaction(history, config.compactAtChars)) {
    const result = await compactSession(state.cwd, session.id, {
      keepTurns: config.compactKeepTurns,
      summarize: summarizerFor(opts, provider, config),
      abortSignal: opts.abortSignal,
    });
    if (result.summarized) {
      compacted = `Auto-compacted ${result.summarized} old messages (${result.method}${result.error ? `, model failed: ${result.error}` : ""}).`;
      history = await loadMessages(state.cwd, session.id);
    }
  }
  const summary = await loadSummary(state.cwd, session.id);
  const memory = await loadMemory(state.cwd);
  const skills = await loadSkills(state.cwd);
  const context = await loadContext(state.cwd);
  const extraPrompts = await pluginPrompts(state.plugins, state.cwd, session.id);
  const at = new Date().toISOString();
  await appendMessage(state.cwd, session.id, { role: "user", content: prompt, at });
  onEvent?.({ type: "accepted" });
  const receipt = await runLoop({
    prompt,
    cwd: state.cwd,
    plugins: state.plugins,
    config,
    confirm,
    sessionId: session.id,
    generate: opts.generate ?? (useLocal ? localGenerate : undefined),
    system: [
      buildSystemPrompt({ cwd: state.cwd, memory, skills, context, summary }),
      ...extraPrompts,
    ].join("\n\n"),
    history,
    provider,
    model: state.modelMode === "pinned" ? state.model : undefined,
    abortSignal: opts.abortSignal,
    onEvent,
    thinking: thinkingOf(loadedSettings.settings).level,
  });
  if (receipt.tokens) {
    state.sessionTokens.input += receipt.tokens.input;
    state.sessionTokens.output += receipt.tokens.output;
  }
  // Save what the model really said, tool calls and results included, so the next turn remembers it.
  await appendMessages(state.cwd, session.id, capToolResults(receipt.newMessages ?? []));
  state.jevHealth = jevHealthFromReceipt(opts.mockJev, receipt);
  state.taskPermission = receipt.taskPermission ?? (await pluginTaskPermission(state.plugins, state.cwd));
  return {
    output: formatReceipt(receipt),
    notice: [notice, compacted].filter(Boolean).join("\n") || undefined,
    session,
    receipt,
  };
}

export async function handleLine(
  line: string,
  state: AppState,
  opts: RunOpts,
  confirm: ConfirmFn = async () => false,
  onEvent?: (event: TurnEvent) => void,
): Promise<HandleResult> {
  const ctx: CommandContext = { state, opts, confirm, onEvent };
  if (line.trim().startsWith("!")) return runUserShell(line.trim(), state, opts);
  const pluginCommand = findPluginCommand(state.plugins, line);
  if (pluginCommand) return pluginCommand.run(pluginCommand.arg, ctx);
  const cmd = parseLine(line);
  if (cmd.type === "unknown") {
    return { output: `unknown command /${cmd.name}. /help lists commands.`, session: state.session };
  }
  if (cmd.type === "empty") {
    return { output: "", session: state.session };
  }
  if (cmd.type === "exit") {
    return { exit: true, output: "", session: state.session };
  }
  if (cmd.type === "help") {
    const extra = state.plugins.flatMap((plugin) => plugin.help ?? []);
    return {
      output: [HELP, ...(extra.length ? ["", "Plugins:", ...extra] : [])].join("\n"),
      session: state.session,
    };
  }
  if (cmd.type === "new" || cmd.type === "clear") {
    for (const plugin of state.plugins) await plugin.onSessionStart?.(state.cwd);
    const session = await createSession(state.cwd);
    state.session = session;
    return { output: `new session ${session.id}`, session, chat: "reset" };
  }
  if (cmd.type === "sessions") {
    const ids = await listSessions(state.cwd);
    return { output: ids.length ? ids.join("\n") : "(none)", session: state.session };
  }
  if (cmd.type === "resume") {
    if (!cmd.id) {
      return { output: "usage: /resume <id>", session: state.session };
    }
    try {
      await switchSession(state.cwd, cmd.id);
      state.session = await loadOrCreateSession(state.cwd);
      return { output: `resumed ${state.session.id}`, session: state.session, chat: "reload" };
    } catch {
      return { output: `no session ${cmd.id}`, session: state.session };
    }
  }
  if (cmd.type === "memory") {
    if (cmd.note) {
      return { output: await addMemory(state.cwd, cmd.note), session: state.session };
    }
    return { output: (await loadMemory(state.cwd)) || "(empty)", session: state.session };
  }
  if (cmd.type === "skills") {
    const skills = await loadSkills(state.cwd);
    return {
      output: skills.length ? skills.map((s) => s.name).join("\n") : "(none)",
      session: state.session,
    };
  }
  if (cmd.type === "compact") {
    const config = loadEnv(state.cwd);
    const provider = opts.local ? "local" : resolveProvider();
    const result = await compactSession(state.cwd, state.session.id, {
      keepTurns: config.compactKeepTurns,
      summarize: summarizerFor(opts, provider, config),
      abortSignal: opts.abortSignal,
    });
    return {
      output: result.summarized
        ? [
            `compacted ${result.summarized} messages into ${result.path} (${result.method}), kept ${result.kept}`,
            result.error ? `model summary failed (${result.error}); used the line-by-line summary` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : `nothing to compact (fewer than ${config.compactKeepTurns + 1} turns)`,
      session: state.session,
    };
  }
  if (cmd.type === "models") {
    return {
      output: formatModelList(state.model, currentCatalog()),
      session: state.session,
    };
  }
  if (cmd.type === "model") {
    if (!cmd.id) {
      return {
        output: state.modelMode === "auto" ? "model  auto (Jev routes spend)" : `model  ${state.model} (pinned)`,
        session: state.session,
      };
    }
    if (cmd.id.toLowerCase() === "auto") {
      await clearPinnedModel(state.cwd);
      state.model = "auto";
      state.modelMode = "auto";
      return { output: "model  auto (Jev routes spend)", session: state.session };
    }
    try {
      state.model = await setPinnedModel(state.cwd, cmd.id);
      state.modelMode = "pinned";
      return { output: `model  ${state.model} (pinned)`, session: state.session };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        session: state.session,
      };
    }
  }
  if (cmd.type === "theme") {
    if (!cmd.name) return { output: `theme  ${themeName()}   (${THEME_NAMES.join(" · ")})`, session: state.session };
    const name = parseTheme(cmd.name);
    if (!name) return { output: `usage: /theme ${THEME_NAMES.join("|")}`, session: state.session };
    saveUserTheme(name);
    return { output: `theme ${name}`, session: state.session };
  }
  if (cmd.type === "think") {
    const loaded = loadSettingsSafe(state.cwd);
    const current = thinkingOf(loaded.settings);
    if (!cmd.arg) {
      return {
        output: [
          `thinking  ${current.level}   (off · low · medium · high)`,
          `shown     ${current.display}   (fold: "Thought for 4s ›", ctrl+t opens · show: live · hide)`,
        ].join("\n"),
        session: state.session,
      };
    }
    if (loaded.error) return { output: `Fix ${settingsPath(state.cwd)} first: ${loaded.error}`, session: state.session };
    const level = parseThinkingLevel(cmd.arg);
    const display = level ? undefined : parseThinkingDisplay(cmd.arg);
    if (!level && !display) return { output: "usage: /think off|low|medium|high  or  /think fold|show|hide", session: state.session };
    saveThinking(state.cwd, level ? { level } : { display });
    return {
      output: level ? `thinking ${level}${level === "off" ? " (no reasoning asked for)" : ""}` : `reasoning ${display === "fold" ? "folded" : display === "show" ? "shown live" : "hidden"}`,
      session: state.session,
    };
  }
  if (cmd.type === "login" || cmd.type === "logout") {
    if (!cmd.provider) return { output: loginStatus(), session: state.session };
    const key = LOGIN_KEYS[cmd.provider];
    if (!key) {
      return { output: `unknown key name '${cmd.provider}'. Use: ${Object.keys(LOGIN_KEYS).join(", ")}`, session: state.session };
    }
    if (cmd.type === "login" && !cmd.key) {
      return { output: `usage: /login ${cmd.provider} <key>`, session: state.session };
    }
    const file = writeUserKey(key.env, cmd.type === "login" ? cmd.key : undefined);
    if (!opts.local) state.provider = resolveProvider();
    if (key.env === "TYPESAFE_API_KEY" && state.plugins.some((plugin) => plugin.scorer)) {
      state.jevHealth = initialJevHealth(opts.mockJev === true, loadSettingsSafe(state.cwd).settings.jev.mode);
    }
    return {
      output:
        cmd.type === "login"
          ? `${key.label}: saved ${maskKey(cmd.key!)} to ${file}. Provider now ${state.provider}.`
          : `${key.label}: removed from ${file}.`,
      session: state.session,
    };
  }
  if (cmd.type === "status") {
    return {
      output: [
        `session   ${state.session.id}`,
        `provider  ${state.provider}`,
        `model     ${state.modelMode === "auto" ? "auto" : state.model}`,
        `jev       ${state.jevHealth}  (mode ${loadSettingsSafe(state.cwd).settings.jev.mode})`,
        `task      ${state.taskPermission}`,
        `thinking  ${thinkingOf(loadSettingsSafe(state.cwd).settings).level} · ${thinkingOf(loadSettingsSafe(state.cwd).settings).display}`,
        `tokens    ${formatTokenLine(state.sessionTokens) || "none yet"} this session`,
        `plugins   ${state.plugins.map((plugin) => plugin.name).join(", ") || "(none)"}${state.unknownPlugins.length ? `  unknown: ${state.unknownPlugins.join(", ")}` : ""}`,
        `settings  ${settingsPath(state.cwd)}`,
        `cwd       ${state.cwd}`,
      ].join("\n"),
      session: state.session,
    };
  }
  if (cmd.type !== "prompt") {
    return { output: "", session: state.session };
  }
  for (const plugin of state.plugins) {
    const answered = await plugin.beforePrompt?.(cmd.text, ctx);
    if (answered) return answered;
  }
  for (const plugin of state.plugins) await plugin.beforeTurn?.(ctx);
  const ran = await runPrompt(cmd.text, state, opts, confirm, onEvent);
  state.session = ran.session;
  return {
    output: ran.receipt ? formatChat(ran.receipt) : ran.output,
    notice: ran.notice,
    session: ran.session,
    receipt: ran.receipt,
  };
}

/** "/task confirm x" → the delivery plugin's "task" handler with "confirm x". Core commands are not overridable. */
function findPluginCommand(plugins: AegisPlugin[], line: string) {
  const text = line.trim();
  if (!text.startsWith("/")) return undefined;
  const [name = "", ...rest] = text.slice(1).split(/\s+/);
  const key = name.toLowerCase();
  for (const plugin of plugins) {
    const run = plugin.commands?.[key];
    if (run) return { run, arg: rest.join(" ").trim() };
  }
  return undefined;
}

/**
 * "!dir" runs a PowerShell command yourself, like Pi's and Claude Code's "!".
 * You typed it, so no rule or Jev check applies. The output goes into the conversation so the model sees it;
 * "!!dir" runs it without adding it. AEGIS_ALLOW_SHELL only limits the model's shell tool.
 */
export async function runUserShell(line: string, state: AppState, opts: RunOpts): Promise<HandleResult> {
  const keep = !line.startsWith("!!");
  const command = line.replace(/^!!?/, "").trim();
  if (!command) return { output: "usage: !<powershell command>   (!! runs it without adding the output to the chat)", session: state.session };
  const config = loadConfig(state.cwd);
  let output: string;
  let failed = false;
  try {
    const { stdout, stderr } = await runPowerShell(command, state.cwd, config.shellTimeoutMs, opts.abortSignal);
    output = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
  } catch (error) {
    failed = true;
    const err = error as { stdout?: string; stderr?: string; message?: string };
    output = [err.stdout?.trimEnd(), err.stderr?.trimEnd()].filter(Boolean).join("\n") || String(err.message ?? error);
  }
  const shown = output.length > 20_000 ? `${output.slice(0, 20_000)}\n[… ${output.length - 20_000} more characters]` : output;
  if (keep) {
    await appendMessage(state.cwd, state.session.id, {
      role: "user",
      content: `I ran this PowerShell command myself:\n> ${command}\n${failed ? "It failed:" : "Output:"}\n${capText(shown, 8_000)}`,
      at: new Date().toISOString(),
    });
  }
  return {
    output: `${failed ? "✗" : "✓"} ${command}${keep ? "" : "  (not added to the chat)"}\n${shown}`,
    session: state.session,
  };
}

function capText(text: string, cap: number) {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n[… ${text.length - cap} more characters]`;
}
