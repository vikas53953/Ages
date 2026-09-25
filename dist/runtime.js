import path from "node:path";
import { loadEnv, hasJevCredentials } from "./env.js";
import { formatReceipt, localGenerate, runLoop } from "./loop.js";
import { formatChat, formatTokenLine } from "./receipt.js";
import { CODEX_CREDENTIAL, loginCodexBrowser, loginCodexDevice } from "./auth/codex.js";
import { loadCredential, saveCredential } from "./auth/store.js";
import { CLAUDE_CODE_MODEL, CLAUDE_MISSING, findClaude, runClaudeCodeTurn } from "./engines/claude-code.js";
import { realOrSelf, rewindPoints, rewindTo, snapshotFile } from "./checkpoints.js";
import { closeMcp, describeServer, mcpServers, startMcp, trustProjectServer } from "./mcp.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { todosFromMessages } from "./todos.js";
import { openUrl } from "./open-url.js";
import { CODEX_MODELS, modelsFor, resolveProvider } from "./providers.js";
import { HELP, parseLine } from "./commands.js";
import { addMemory, loadMemory } from "./memory.js";
import { loadSkills } from "./skills.js";
import { loadContext } from "./context.js";
import { compactSession, loadSummary, modelSummarizer, needsCompaction } from "./compact.js";
import { buildSystemPrompt } from "./system.js";
import { currentCatalog, formatModelList, refreshCatalog } from "./catalog.js";
import { clearPinnedModel, defaultModelId, loadPinnedModel, setPinnedModel } from "./model-pin.js";
import { createSession, listSessions, loadMessages, loadOrCreateSession, switchSession, recentSessions, appendMessage, appendMessages, capToolResults, } from "./session.js";
import { loadSettingsSafe, saveThinking, settingsPath, thinkingOf } from "./rules.js";
import { parseThinkingDisplay, parseThinkingLevel } from "./thinking.js";
import { THEME_NAMES, parseTheme, saveUserTheme, themeName } from "./theme.js";
import { initialJevHealth, jevHealthFromReceipt } from "./health.js";
import { runPowerShell } from "./tools/fs.js";
import { LOGIN_KEYS, loginStatus, maskKey, writeUserKey } from "./login.js";
import { APP_NAME, APP_VERSION, displayUser } from "./brand.js";
import { loadConfig } from "./config.js";
export { initialJevHealth, jevHealthFromReceipt } from "./health.js";
import { KNOWN_PLUGINS, loadPlugins } from "./plugins/index.js";
/** Start MCP servers once per window, even when two callers ask at the same moment; later calls reuse them. */
async function ensureMcp(state) {
    if (state.mcp)
        return state.mcp;
    const starting = (state.mcpStarting ??= startMcp(state.cwd));
    const mcp = await starting;
    if (state.mcpStarting === starting)
        state.mcp = mcp;
    else
        closeMcp(mcp); // closed while starting
    return state.mcp ?? mcp;
}
function mcpBindings(mcp) {
    return mcp.tools.map((tool) => ({
        tool,
        call: (args, signal) => {
            const connection = mcp.connections.find((item) => item.name === tool.server);
            if (!connection || connection.closed)
                return Promise.resolve(`MCP server ${tool.server} is not running. /mcp restart`);
            return connection.callTool(tool.tool, args, signal);
        },
    }));
}
/** The model's current todo list (from the conversation, so /rewind and /resume stay right). */
export async function currentTodos(state) {
    return todosFromMessages(await loadMessages(state.cwd, state.session.id));
}
/** Stop what this window started (MCP servers). Safe to call twice. */
export function closeState(state) {
    closeMcp(state.mcp);
    state.mcp = undefined;
    state.mcpStarting = undefined;
}
export async function startState(cwd, opts) {
    const session = opts.newSession ? await createSession(cwd) : await loadOrCreateSession(cwd);
    const provider = opts.local ? "local" : resolveProvider();
    const config = loadEnv(cwd);
    // The live model list arrives in the background; startup never waits on the network (the built-in list is used until then).
    void refreshCatalog();
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
        provider: providerLabel(state.provider),
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
export function providerLabel(provider) {
    if (provider === "codex") {
        const email = loadCredential(CODEX_CREDENTIAL)?.email;
        return `ChatGPT plan${email ? ` (${email})` : ""}`;
    }
    return provider === "opencode" ? "OpenCode Zen" : provider === "openai" ? "OpenAI" : "local, no key";
}
/** Entries for the /model picker: "auto" first, then the live catalogue grouped by provider. */
export function modelChoices(state) {
    const config = loadConfig(state.cwd);
    const models = modelsFor(state.provider, config);
    const catalog = state.provider === "codex" ? CODEX_MODELS.map((row) => ({ ...row, group: "ChatGPT plan" })) : currentCatalog();
    const rows = catalog.map((entry) => ({
        id: entry.id,
        group: entry.group,
        note: entry.id === models.frontier
            ? `${entry.name} · default frontier`
            : entry.id === models.cheap
                ? `${entry.name} · default cheap`
                : entry.name,
    }));
    const defaults = rows.filter((row) => row.id === models.frontier || row.id === models.cheap);
    return [
        { id: "auto", group: "Aegis", note: `Jev picks ${models.cheap} or ${models.frontier} each turn` },
        ...defaults.map((row) => ({ ...row, group: "Defaults" })),
        { id: CLAUDE_CODE_MODEL, group: "Engines", note: "your Claude plan, via the Claude Code you installed" },
        ...rows.filter((row) => !defaults.includes(row)),
    ];
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
    const claudeEngine = state.modelMode === "pinned" && state.model === CLAUDE_CODE_MODEL;
    const useLocal = !claudeEngine && (opts.local === true || provider === "local");
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
    // Claude Code keeps and compacts its own conversation; Aegis only records prompts and answers for it.
    if (!claudeEngine && needsCompaction(history, config.compactAtChars)) {
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
    const checkpoint = (file) => snapshotFile(state.cwd, session.id, { at, prompt }, file);
    const readOnly = state.planMode ? "plan mode is read-only: write the plan; changes start after /plan go" : undefined;
    const planPrompt = state.planMode ? PLAN_PROMPT : "";
    // Claude Code runs its own MCP servers; Aegis's go to Aegis's own loop.
    const mcpTools = claudeEngine || !mcpServers(state.cwd).length ? [] : mcpBindings(await ensureMcp(state));
    onEvent?.({ type: "accepted" });
    const receipt = claudeEngine
        ? await runClaudeCodeTurn({
            prompt,
            cwd: state.cwd,
            sessionId: session.id,
            config,
            confirm,
            plugins: state.plugins,
            onEvent,
            abortSignal: opts.abortSignal,
            checkpoint,
            readOnly,
            appendSystem: [context, memory ? `## Memory\n${memory}` : "", ...extraPrompts, planPrompt].filter(Boolean).join("\n\n") || undefined,
        })
        : await runLoop({
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
                planPrompt,
            ]
                .filter(Boolean)
                .join("\n\n"),
            history,
            provider,
            model: state.modelMode === "pinned" ? state.model : undefined,
            abortSignal: opts.abortSignal,
            onEvent,
            thinking: thinkingOf(loadedSettings.settings).level,
            checkpoint,
            readOnly,
            mcpTools,
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
        state.planMode = false;
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
        if (cmd.id.toLowerCase() === CLAUDE_CODE_MODEL && !findClaude()) {
            return { output: CLAUDE_MISSING, session: state.session };
        }
        try {
            state.model = await setPinnedModel(state.cwd, cmd.id);
            state.modelMode = "pinned";
            if (state.model === CLAUDE_CODE_MODEL) {
                return {
                    output: `model  claude-code (pinned): turns run in your own Claude Code, on your Claude plan. Every tool call still passes Aegis's lock.\n/model auto goes back.`,
                    session: state.session,
                };
            }
            return { output: `model  ${state.model} (pinned)`, session: state.session };
        }
        catch (error) {
            return {
                output: error instanceof Error ? error.message : String(error),
                session: state.session,
            };
        }
    }
    if (cmd.type === "rewind")
        return rewindCommand(cmd.arg, cmd.what, state);
    if (cmd.type === "mcp")
        return mcpCommand(cmd.action, cmd.name, state);
    if (cmd.type === "todos") {
        const todos = await currentTodos(state);
        const mark = { pending: "[ ]", in_progress: "[>]", completed: "[x]", cancelled: "[-]" };
        return {
            output: todos.length ? todos.map((todo) => `${mark[todo.status]} ${todo.content}`).join("\n") : "No todo list in this session.",
            session: state.session,
        };
    }
    if (cmd.type === "doctor")
        return { output: formatDoctor(await runDoctor(state.cwd)), session: state.session };
    if (cmd.type === "plan") {
        const arg = (cmd.arg ?? "").toLowerCase();
        if (arg === "off") {
            state.planMode = false;
            return { output: "plan mode off: the agent can change files again (your rules still decide)", session: state.session };
        }
        if (arg === "go" || arg === "approve") {
            if (!state.planMode)
                return { output: "plan mode is not on. /plan turns it on.", session: state.session };
            state.planMode = false;
            try {
                return await runPrompt(PLAN_GO, state, opts, confirm, onEvent);
            }
            catch (error) {
                state.planMode = true; // nothing was carried out: stay in plan mode
                throw error;
            }
        }
        if (!arg) {
            state.planMode = true;
            return {
                output: "plan mode on: the agent reads and searches only, and ends with a numbered plan. /plan go carries it out · /plan off leaves",
                session: state.session,
            };
        }
        // "/plan add a login page": plan mode on, and plan this now.
        state.planMode = true;
        return runPrompt(cmd.arg, state, opts, confirm, onEvent);
    }
    if (cmd.type === "theme") {
        if (!cmd.name)
            return { output: `theme  ${themeName()}   (${THEME_NAMES.join(" · ")})`, session: state.session };
        const name = parseTheme(cmd.name);
        if (!name)
            return { output: `usage: /theme ${THEME_NAMES.join("|")}`, session: state.session };
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
        if (loaded.error)
            return { output: `Fix ${settingsPath(state.cwd)} first: ${loaded.error}`, session: state.session };
        const level = parseThinkingLevel(cmd.arg);
        const display = level ? undefined : parseThinkingDisplay(cmd.arg);
        if (!level && !display)
            return { output: "usage: /think off|low|medium|high  or  /think fold|show|hide", session: state.session };
        saveThinking(state.cwd, level ? { level } : { display });
        return {
            output: level ? `thinking ${level}${level === "off" ? " (no reasoning asked for)" : ""}` : `reasoning ${display === "fold" ? "folded" : display === "show" ? "shown live" : "hidden"}`,
            session: state.session,
        };
    }
    if ((cmd.type === "login" || cmd.type === "logout") && (cmd.provider === "chatgpt" || cmd.provider === "codex")) {
        return chatgptLogin(cmd.type, cmd.type === "login" ? cmd.key : undefined, state, opts, onEvent);
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
                `provider  ${providerLabel(state.provider)}`,
                `plan      ${state.planMode ? "on (read-only until /plan go)" : "off"}`,
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
const PLAN_PROMPT = [
    "## Plan mode",
    "You are in plan mode. Read and search only; every other tool is refused until the owner approves.",
    "Study what you need, then answer with: the goal in one line, a numbered list of concrete steps (files to change and how),",
    "how you will test it, and open questions. Do not claim to have changed anything.",
].join("\n");
const PLAN_GO = "The plan is approved. Carry it out now, step by step, then say how you tested it.";
/** /mcp: servers and tools; /mcp trust <name>; /mcp restart. */
async function mcpCommand(action, name, state) {
    const reply = (output) => ({ output, session: state.session });
    if (action === "trust") {
        if (!name)
            return reply("usage: /mcp trust <name>   (a server from this project's .aegis/settings.json)");
        const server = mcpServers(state.cwd).find((item) => item.name === name && item.scope === "project");
        if (!server)
            return reply(`No project MCP server named ${name}. /mcp lists them.`);
        trustProjectServer(state.cwd, name);
        closeState(state);
        const mcp = await ensureMcp(state);
        return reply(`Trusted ${name} for this folder: ${describeServer(server)}\n${mcp.status.map((row) => `  ${row.name}  ${row.state}`).join("\n")}`);
    }
    if (action === "restart")
        closeState(state);
    if (action && action !== "restart")
        return reply("usage: /mcp · /mcp trust <name> · /mcp restart");
    const servers = mcpServers(state.cwd);
    if (!servers.length) {
        return reply([
            "No MCP servers. Add one under \"mcp\" in ~/.aegis/settings.json (yours) or .aegis/settings.json (this project):",
            '  { "mcp": { "servers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } } }',
            "Each tool is named mcp__<server>__<tool> and passes your rules: e.g. allow \"mcp__files__read_file\", ask \"mcp__files__*\".",
        ].join("\n"));
    }
    const mcp = await ensureMcp(state);
    return reply([
        "MCP servers (tools pass your rules like any other tool):",
        ...mcp.status.map((row) => `  ${row.name.padEnd(14)} ${row.scope.padEnd(8)} ${row.state}`),
        ...(mcp.tools.length ? ["", "Tools:", ...mcp.tools.map((tool) => `  ${tool.name}`)] : []),
    ].join("\n"));
}
/** /rewind: list restore points, or put files and/or the conversation back to before a turn. */
async function rewindCommand(arg, what, state) {
    const points = await rewindPoints(state.cwd, state.session.id);
    const root = await realOrSelf(state.cwd);
    const short = (file) => {
        const relative = path.relative(root, file);
        return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
    };
    if (!arg) {
        if (!points.length)
            return { output: "No restore points yet. Aegis keeps a file before each write or edit you allow.", session: state.session };
        return {
            output: [
                "Restore points (newest first). /rewind <n> puts files and chat back to before that turn;",
                "add 'files' or 'chat' to rewind just one. Shell commands are not undone.",
                ...points.slice(0, 15).map((point, index) => {
                    const files = point.files.map(short);
                    return `  ${String(index + 1).padStart(2)}  ${point.turnAt.slice(11, 19)}  "${point.prompt.slice(0, 50)}"  ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""}`;
                }),
            ].join("\n"),
            session: state.session,
        };
    }
    const index = Number(arg) - 1;
    const point = Number.isInteger(index) ? points[index] : undefined;
    if (!point)
        return { output: `usage: /rewind <1-${points.length || 1}> [files|chat]   (/rewind lists them)`, session: state.session };
    if (what && what !== "files" && what !== "chat" && what !== "both") {
        return { output: "usage: /rewind <n> [files|chat]", session: state.session };
    }
    const done = await rewindTo(state.cwd, state.session.id, point.turnAt, {
        files: what !== "chat",
        chat: what !== "files",
    });
    return {
        output: [
            `Rewound to before "${point.prompt.slice(0, 60)}".`,
            done.restored.length ? `  restored  ${done.restored.map(short).join(", ")}` : "",
            done.removed.length ? `  removed   ${done.removed.map(short).join(", ")} (did not exist before)` : "",
            ...done.skipped.map((item) => `  not restored  ${short(item.file)} (${item.reason})`),
            what !== "files" ? `  conversation: ${done.messagesDropped} message(s) dropped` : "",
            what !== "files" && state.modelMode === "pinned" && state.model === CLAUDE_CODE_MODEL
                ? "  Claude Code starts a fresh conversation (it cannot drop only some turns)"
                : "",
        ]
            .filter(Boolean)
            .join("\n"),
        session: state.session,
        chat: what !== "files" ? "reload" : undefined,
    };
}
/** /login chatgpt [browser]: sign in with a ChatGPT plan (device code by default). /logout chatgpt forgets it. */
async function chatgptLogin(kind, method, state, opts, onEvent) {
    if (kind === "logout") {
        const file = saveCredential(CODEX_CREDENTIAL, undefined);
        if (!opts.local)
            state.provider = resolveProvider();
        return { output: `ChatGPT: signed out (removed from ${file}). Provider now ${state.provider}.`, session: state.session };
    }
    if (method && method !== "browser" && method !== "device") {
        return { output: "usage: /login chatgpt            (a code to type at auth.openai.com)\n       /login chatgpt browser    (sign in in this PC's browser)", session: state.session };
    }
    const ui = {
        show: (text) => onEvent?.({ type: "notice", text }),
        signal: opts.abortSignal,
        openUrl: (url) => void openUrl(url),
    };
    const credential = method === "browser" ? await loginCodexBrowser(ui) : await loginCodexDevice(ui);
    const file = saveCredential(CODEX_CREDENTIAL, credential);
    if (!opts.local)
        state.provider = resolveProvider();
    return {
        output: [
            `Signed in to ChatGPT${credential.email ? ` as ${credential.email}` : ""}. Saved to ${file} (only your account can read it).`,
            `Provider now ${providerLabel(state.provider)}. Models: /model   ·   Sign out: /logout chatgpt`,
            opts.local ? "(--local is on: chat stays local until you start aegis without it)" : "",
        ]
            .filter(Boolean)
            .join("\n"),
        session: state.session,
    };
}
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
