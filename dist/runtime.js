import { loadEnv, hasJevCredentials } from "./env.js";
import { formatReceipt, localGenerate, runLoop } from "./loop.js";
import { formatChat } from "./receipt.js";
import { modelsFor, resolveProvider } from "./providers.js";
import { HELP, parseLine } from "./commands.js";
import { addMemory, loadMemory } from "./memory.js";
import { loadSkills } from "./skills.js";
import { loadContext } from "./context.js";
import { compactSession, loadSummary, modelSummarizer, needsCompaction } from "./compact.js";
import { buildSystemPrompt } from "./system.js";
import { currentCatalog, formatModelList, refreshCatalog } from "./catalog.js";
import { clearPinnedModel, defaultModelId, loadPinnedModel, setPinnedModel } from "./model-pin.js";
import { createSession, listSessions, loadMessages, loadOrCreateSession, switchSession, recentSessions, appendMessage, appendMessages, capToolResults, } from "./session.js";
import { loadSettingsSafe, settingsPath } from "./rules.js";
import { initialJevHealth, jevHealthFromReceipt } from "./health.js";
import { runPowerShell } from "./tools/fs.js";
import { LOGIN_KEYS, loginStatus, maskKey, writeUserKey } from "./login.js";
import { APP_NAME, APP_VERSION, displayUser } from "./brand.js";
import { loadConfig } from "./config.js";
export { initialJevHealth, jevHealthFromReceipt } from "./health.js";
import { KNOWN_PLUGINS, loadPlugins } from "./plugins/index.js";
export async function startState(cwd, opts) {
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
    for (const plugin of plugins)
        await plugin.onSessionStart?.(cwd);
    const permission = await pluginTaskPermission(plugins, cwd);
    const base = { cwd, session, provider, jevHealth, taskPermission: permission, plugins, unknownPlugins: unknown };
    if (pinned)
        return { ...base, model: pinned, modelMode: "pinned" };
    return { ...base, model: "auto", modelMode: "auto" };
}
async function pluginTaskPermission(plugins, cwd) {
    for (const plugin of plugins) {
        if (plugin.taskPermission)
            return plugin.taskPermission(cwd);
    }
    return "untracked";
}
/** Everything the welcome screen shows, read fresh (after /new, /login, /jev it changes). */
export async function welcomeInfo(state) {
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
    };
}
/** Text every enabled plugin adds to the system prompt (context:assemble). */
async function pluginPrompts(plugins, cwd, sessionId) {
    const parts = [];
    for (const plugin of plugins) {
        const text = await plugin.systemPrompt?.({ cwd, sessionId });
        if (text)
            parts.push(text);
    }
    return parts;
}
/** The cheap chat model writes compaction summaries. Local mode has no model, so the extractive summary is used. */
function summarizerFor(opts, provider, config) {
    if (opts.summarize)
        return opts.summarize;
    if (opts.local || provider === "local")
        return undefined;
    return modelSummarizer(modelsFor(provider, config).cheap);
}
export async function runPrompt(prompt, state, opts, confirm, onEvent) {
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
    });
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
export async function handleLine(line, state, opts, confirm = async () => false, onEvent) {
    const ctx = { state, opts, confirm, onEvent };
    if (line.trim().startsWith("!"))
        return runUserShell(line.trim(), state, opts);
    const pluginCommand = findPluginCommand(state.plugins, line);
    if (pluginCommand)
        return pluginCommand.run(pluginCommand.arg, ctx);
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
        for (const plugin of state.plugins)
            await plugin.onSessionStart?.(state.cwd);
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
        }
        catch {
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
        }
        catch (error) {
            return {
                output: error instanceof Error ? error.message : String(error),
                session: state.session,
            };
        }
    }
    if (cmd.type === "login" || cmd.type === "logout") {
        if (!cmd.provider)
            return { output: loginStatus(), session: state.session };
        const key = LOGIN_KEYS[cmd.provider];
        if (!key) {
            return { output: `unknown key name '${cmd.provider}'. Use: ${Object.keys(LOGIN_KEYS).join(", ")}`, session: state.session };
        }
        if (cmd.type === "login" && !cmd.key) {
            return { output: `usage: /login ${cmd.provider} <key>`, session: state.session };
        }
        const file = writeUserKey(key.env, cmd.type === "login" ? cmd.key : undefined);
        if (!opts.local)
            state.provider = resolveProvider();
        if (key.env === "TYPESAFE_API_KEY" && state.plugins.some((plugin) => plugin.scorer)) {
            state.jevHealth = initialJevHealth(opts.mockJev === true, loadSettingsSafe(state.cwd).settings.jev.mode);
        }
        return {
            output: cmd.type === "login"
                ? `${key.label}: saved ${maskKey(cmd.key)} to ${file}. Provider now ${state.provider}.`
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
        if (answered)
            return answered;
    }
    for (const plugin of state.plugins)
        await plugin.beforeTurn?.(ctx);
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
function findPluginCommand(plugins, line) {
    const text = line.trim();
    if (!text.startsWith("/"))
        return undefined;
    const [name = "", ...rest] = text.slice(1).split(/\s+/);
    const key = name.toLowerCase();
    for (const plugin of plugins) {
        const run = plugin.commands?.[key];
        if (run)
            return { run, arg: rest.join(" ").trim() };
    }
    return undefined;
}
/**
 * "!dir" runs a PowerShell command yourself, like Pi's and Claude Code's "!".
 * You typed it, so no rule or Jev check applies. The output goes into the conversation so the model sees it;
 * "!!dir" runs it without adding it. AEGIS_ALLOW_SHELL only limits the model's shell tool.
 */
export async function runUserShell(line, state, opts) {
    const keep = !line.startsWith("!!");
    const command = line.replace(/^!!?/, "").trim();
    if (!command)
        return { output: "usage: !<powershell command>   (!! runs it without adding the output to the chat)", session: state.session };
    const config = loadConfig(state.cwd);
    let output;
    let failed = false;
    try {
        const { stdout, stderr } = await runPowerShell(command, state.cwd, config.shellTimeoutMs, opts.abortSignal);
        output = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
    }
    catch (error) {
        failed = true;
        const err = error;
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
function capText(text, cap) {
    return text.length <= cap ? text : `${text.slice(0, cap)}\n[… ${text.length - cap} more characters]`;
}
