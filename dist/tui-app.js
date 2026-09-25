import { CombinedAutocompleteProvider, Editor, getKeybindings, isViewportTUI, Key, Markdown, matchesKey, ProcessTerminal, ScrollView, truncateToWidth, Text, TuiAltScreen, VStack, } from "@earendil-works/pi-tui";
import { HELP, slashCommandsFromHelp } from "./commands.js";
import { serializeConfirm } from "./confirm-queue.js";
import { closeState, currentTodos, extensionHelp, handleLine, modelChoices, startState, welcomeInfo } from "./runtime.js";
import { todoLines } from "./todos.js";
import { loadSettingsSafe, saveThinking, thinkingOf } from "./rules.js";
import { formatTokenLine } from "./receipt.js";
import { ModelPicker } from "./tui-model-picker.js";
import { loadUserTheme, paint } from "./theme.js";
import { shortPath, welcomeLines } from "./welcome.js";
import { redactLogin } from "./login.js";
import { loadMessages, messageText } from "./session.js";
import { ConfirmBox } from "./tui-confirm.js";
import { MemoryTerminal } from "./tui-memory.js";
import { footerText, renderSystemMessage, renderThinking, renderToolLine, renderUserMessage, sanitizeText, turnStatusLines, } from "./tui-layout.js";
import { loadBell, shouldRing } from "./bell.js";
const dim = (text) => paint("dim", text);
/** How the model's Markdown answers look, in the current theme's colours. */
const markdownTheme = () => ({
    heading: (text) => paint("strong", text),
    link: (text) => `\x1b[4m${paint("accent", text)}`,
    linkUrl: (text) => paint("dim", text),
    code: (text) => paint("accent", text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => paint("dim", text),
    quote: (text) => paint("italic", text),
    quoteBorder: (text) => paint("dim", text),
    hr: (text) => paint("dim", text),
    listBullet: (text) => paint("accent", text),
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    italic: (text) => `\x1b[3m${text}\x1b[23m`,
    strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
    underline: (text) => `\x1b[4m${text}\x1b[24m`,
});
const editorTheme = {
    borderColor: dim,
    selectList: {
        selectedPrefix: (text) => text,
        selectedText: (text) => text,
        description: dim,
        scrollInfo: dim,
        noMatch: dim,
    },
};
class OneLine {
    text = "";
    setText(text) {
        this.text = text;
    }
    invalidate() { }
    render(width) {
        return [truncateToWidth(this.text, Math.max(1, width), "…")];
    }
}
export async function createTuiApp(opts, input = {}) {
    const cwd = input.cwd ?? process.cwd();
    loadUserTheme();
    const terminal = input.terminal ?? new ProcessTerminal();
    const runLine = input.handleLine ?? handleLine;
    const state = await startState(cwd, opts);
    getKeybindings().setUserBindings({
        "tui.altScreen.top": ["ctrl+shift+home"],
        "tui.altScreen.bottom": ["ctrl+shift+end"],
        "tui.altScreen.search": [],
    });
    const tui = new TuiAltScreen(terminal, true, undefined, {
        mouse: true,
        wheelScrollLines: 3,
    });
    tui.setClearOnShrink(true);
    // Welcome screen: redrawn at the current width, refreshed after commands that change what it shows.
    let welcome;
    const header = {
        render: (width) => (welcome ? welcomeLines(welcome, width, !input.terminal || !(input.terminal instanceof MemoryTerminal)) : []),
        invalidate: () => { },
    };
    const refreshWelcome = async () => {
        welcome = await welcomeInfo(state);
        tui.requestRender();
    };
    const transcript = new Text("", 0, 0);
    let thinkingDisplay = thinkingOf(loadSettingsSafe(cwd).settings).display;
    let thinkingLevel = thinkingOf(loadSettingsSafe(cwd).settings).level;
    const refreshThinking = () => {
        const current = thinkingOf(loadSettingsSafe(cwd).settings);
        thinkingDisplay = current.display;
        thinkingLevel = current.level;
    };
    /** Close an open reasoning block when the answer, a tool, or the end of the turn arrives. */
    const endThinking = () => {
        const last = log.at(-1);
        if (last?.role === "thinking" && !last.endedAt)
            last.endedAt = Date.now();
    };
    const log = [];
    let lastNotice = "";
    let streamedThisTurn = false;
    let lastConfirm = "";
    // One line that never wraps, like Pi's footer: long values are cut with "…" at the terminal edge.
    const footer = new OneLine();
    const editor = new Editor(tui, editorTheme, { paddingX: 0 });
    // Type / for commands (core + plugins), @ for files — the same pi-tui provider Pi uses.
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommandsFromHelp([...HELP.split("\n"), ...state.plugins.flatMap((plugin) => plugin.help ?? []), ...(await extensionHelp(cwd))]), cwd));
    // Claude-Code-style working line above the editor: spinner, what is happening, time, how to stop.
    const status = new Text("", 0, 0);
    // The model's todo list, above the working line; empty (and gone) when nothing is open.
    const todoBox = new Text("", 0, 0);
    const showTodos = (todos) => {
        const lines = todoLines(todos);
        todoBox.setText(lines.length ? lines.map((line) => paint("dim", `  ${line}`)).join("\n") : "");
    };
    // Messages typed while a turn runs wait here (like Claude Code and Pi) and go one by one after it.
    const queued = [];
    const queueBox = new Text("", 0, 0);
    const showQueue = () => {
        queueBox.setText(queued.length ? queued.map((text) => paint("dim", `  ⏎ queued: ${redactLogin(text).split("\n")[0].slice(0, 100)}`)).join("\n") : "");
    };
    const dock = new VStack([todoBox, queueBox, status, editor, footer]);
    const scroll = new ScrollView(new VStack([header, transcript]), {
        follow: "end",
        primary: true,
        overscroll: "chain",
        scrollbar: "auto",
    });
    if (!isViewportTUI(tui)) {
        throw new Error("Aegis TUI needs an application-owned viewport.");
    }
    tui.setLayoutRoot(new VStack([
        { component: scroll, basis: 0, grow: 1, minSize: 3 },
        { component: dock, basis: "auto", shrink: 0, minSize: 4 },
    ]));
    let busy = false;
    let alive = true;
    let phase = "idle";
    let turnStarted = 0;
    let elapsedTimer;
    let streamAt;
    let turnAbort = new AbortController();
    let overlay;
    const pendingConfirms = [];
    let closed = () => { };
    const finished = new Promise((resolve) => {
        closed = resolve;
    });
    const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let spin = 0;
    let exitArmedAt = 0;
    const paintStatus = () => {
        if (busy) {
            const seconds = Math.max(0, Math.floor((Date.now() - turnStarted) / 1000));
            const frame = SPINNER[spin++ % SPINNER.length];
            status.setText(`${paint("accent", frame ?? "")} ${phase}… ${paint("dim", `${seconds}s · esc to stop`)}`);
        }
        else if (exitArmedAt && Date.now() - exitArmedAt < 1500) {
            status.setText(paint("dim", "Press ctrl+c again to exit"));
        }
        else {
            status.setText("");
        }
    };
    const paintFooter = () => {
        paintStatus();
        footer.setText(footerText({
            modelMode: state.modelMode,
            model: state.model,
            jev: state.jevHealth,
            provider: state.provider,
            busy,
            phase: busy ? phase : undefined,
            elapsedMs: busy && turnStarted ? Date.now() - turnStarted : 0,
            task: state.taskPermission,
            cwd: shortPath(cwd, Math.max(12, Math.floor(terminal.columns / 4))),
            think: thinkingLevel,
            tokens: formatTokenLine(state.sessionTokens),
            context: state.contextPercent,
            plan: state.planMode,
        }));
    };
    const paintTranscript = () => {
        const width = Math.max(20, terminal.columns - 2);
        const lines = [];
        for (const item of log) {
            if (item.role === "user")
                lines.push(...renderUserMessage(item.text, width));
            else if (item.role === "thinking") {
                const shown = renderThinking({ text: item.text, startedAt: item.startedAt ?? Date.now(), endedAt: item.endedAt }, thinkingDisplay, width);
                if (!shown.length)
                    continue;
                lines.push(...shown);
            }
            else if (item.role === "tool")
                lines.push(...renderToolLine({ text: item.text, status: item.status ?? "pending", detail: item.detail }, width));
            else if (item.role === "assistant")
                lines.push(...new Markdown(item.text, 2, 0, markdownTheme()).render(width));
            else
                lines.push(...renderSystemMessage(item.text, width));
            lines.push("");
        }
        transcript.setText(lines.join("\n").trimEnd());
        scroll.scrollToEnd();
        tui.requestRender();
    };
    const add = (role, text) => {
        const clean = sanitizeText(text).trim();
        if (!clean)
            return;
        log.push({ role, text: clean });
        paintTranscript();
    };
    const loadConversation = async () => {
        log.length = 0;
        const history = await loadMessages(cwd, state.session.id);
        for (const message of history) {
            if (message.role === "tool")
                continue;
            const text = messageText(message);
            if (/Paste OPENCODE_API_KEY|No chat key this run|Local planner only/.test(text)) {
                continue;
            }
            add(message.role === "user" ? "user" : "assistant", text);
        }
        paintTranscript();
    };
    // The terminal bell (/bell): read each time, so a change applies at once.
    const ring = (moment, elapsedMs = 0) => {
        if (alive && shouldRing(loadBell(), moment, elapsedMs))
            terminal.write("\x07");
    };
    const confirm = serializeConfirm((question, options) => new Promise((resolve) => {
        lastConfirm = question;
        overlay?.hide();
        let settled = false;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            const at = pendingConfirms.indexOf(finish);
            if (at >= 0)
                pendingConfirms.splice(at, 1);
            overlay?.hide();
            overlay = undefined;
            editor.disableSubmit = false;
            tui.setFocus(editor);
            resolve(ok);
            tui.requestRender();
        };
        pendingConfirms.push(finish);
        ring("ask");
        editor.disableSubmit = true;
        overlay = tui.showOverlay(new ConfirmBox(question, finish, terminal.rows, options?.always), {
            anchor: "bottom-center",
            width: "96%",
            maxHeight: "80%",
            margin: 1,
        });
        tui.requestRender();
    }));
    /** /model opens a searchable list; picking runs "/model <id>" so pinning works exactly as when typed. */
    const openModelPicker = () => {
        overlay?.hide();
        const picker = new ModelPicker(modelChoices(state), state.modelMode === "pinned" ? state.model : "auto", (id) => {
            overlay?.hide();
            overlay = undefined;
            editor.disableSubmit = false;
            tui.setFocus(editor);
            tui.requestRender();
            if (id)
                void submit(`/model ${id}`);
        }, terminal.rows);
        editor.disableSubmit = true;
        overlay = tui.showOverlay(picker, { anchor: "bottom-center", width: "80%", maxHeight: "80%", margin: 1 });
        tui.requestRender();
    };
    const denyWaiters = () => {
        overlay?.hide();
        overlay = undefined;
        while (pendingConfirms.length)
            pendingConfirms.shift()?.(false);
        editor.disableSubmit = false;
        if (alive)
            tui.setFocus(editor);
    };
    const setBusy = (next) => {
        busy = next;
        // Enter stays live while busy: the message is queued, not lost.
        editor.disableSubmit = Boolean(overlay);
        terminal.setProgress(next);
        if (next) {
            turnStarted = Date.now();
            elapsedTimer ??= setInterval(() => {
                if (!alive)
                    return;
                paintFooter();
                tui.requestRender();
            }, 250);
        }
        else {
            if (elapsedTimer) {
                clearInterval(elapsedTimer);
                elapsedTimer = undefined;
            }
            phase = "idle";
            turnStarted = 0;
            streamAt = undefined;
        }
        paintFooter();
        tui.requestRender();
    };
    const applyEvent = (event) => {
        if (event.type === "todos") {
            showTodos(event.todos);
            return;
        }
        if (event.type === "notice") {
            add("system", event.text);
            return;
        }
        if (event.type === "accepted") {
            phase = "evaluating";
            return;
        }
        if (event.type === "evaluating") {
            phase = "jev scoring the turn";
            return;
        }
        if (event.type === "route") {
            phase = "waiting for model";
            if (event.reason !== "selected")
                add("system", `model ${event.model} · ${event.reason}`);
            return;
        }
        if (event.type === "waiting_model") {
            phase = "waiting for model";
            return;
        }
        if (event.type === "tool_start") {
            const verb = event.name === "read"
                ? "reading"
                : event.name === "edit"
                    ? "editing"
                    : event.name === "write"
                        ? "writing"
                        : event.name === "grep"
                            ? "searching"
                            : event.name;
            phase = event.target ? `${verb} ${event.target}` : verb;
            endThinking();
            streamAt = undefined; // text after a tool starts a new answer block
            log.push({
                role: "tool",
                text: `${event.name}${event.target ? ` ${event.target}` : ""}`,
                status: "pending",
                key: `${event.name}\u0000${event.target ?? ""}`,
            });
            paintTranscript();
            return;
        }
        if (event.type === "awaiting_approval") {
            phase = "waiting for your y/N";
            return;
        }
        if (event.type === "tool") {
            const record = event.record;
            const key = `${record.name}\u0000${record.target ?? ""}`;
            const item = [...log].reverse().find((row) => row.role === "tool" && row.status === "pending" && row.key === key);
            const decidedBy = record.rule ? `rule ${record.rule}` : record.source === "default" ? "you" : `${record.source ?? "jev"}`;
            const detail = record.approved
                ? record.savedRule
                    ? `you: always allow · saved rule ${record.savedRule}`
                    : record.saveFailed
                        ? `you said yes · rule not saved (${record.saveFailed})`
                        : `${record.action === "confirm" ? "you said yes" : "auto"} · ${decidedBy}`
                : `denied · ${record.deniedReason ?? "no reason"}`;
            if (item) {
                item.status = record.approved ? "ran" : "denied";
                item.detail = detail;
            }
            else {
                log.push({ role: "tool", text: `${record.name}${record.target ? ` ${record.target}` : ""}`, status: record.approved ? "ran" : "denied", detail });
            }
            if (!record.approved && record.source === "agreement")
                phase = "blocked";
            paintTranscript();
            return;
        }
        if (event.type === "reasoning_delta") {
            phase = "thinking";
            const last = log.at(-1);
            if (last?.role === "thinking" && !last.endedAt)
                last.text += event.text;
            else {
                log.push({ role: "thinking", text: event.text, startedAt: Date.now() });
                streamAt = undefined;
            }
            paintTranscript();
            return;
        }
        if (event.type === "text_delta") {
            phase = "waiting for model";
            endThinking();
            const chunk = event.text;
            if (!chunk)
                return;
            streamedThisTurn = true;
            if (streamAt === undefined) {
                log.push({ role: "assistant", text: chunk });
                streamAt = log.length - 1;
            }
            else {
                const current = log[streamAt];
                if (current)
                    current.text += chunk;
            }
            paintTranscript();
            return;
        }
        if (event.type === "outcome") {
            phase = event.outcome === "completed" ? "finished" : event.outcome;
        }
    };
    const applyChat = async (result) => {
        if (result.chat === "reset") {
            log.length = 0;
            showTodos([]);
            paintTranscript();
            return;
        }
        if (result.chat === "reload") {
            await loadConversation();
            showTodos(await currentTodos(state));
        }
    };
    const submit = async (line) => {
        const text = line.trim();
        if (!alive || !text)
            return;
        if (busy) {
            editor.addToHistory(redactLogin(text));
            editor.setText("");
            queued.push(text);
            showQueue();
            tui.requestRender();
            return;
        }
        editor.setText("");
        if (text === "/model") {
            editor.addToHistory(text);
            openModelPicker();
            return;
        }
        // Never echo or keep an API key typed with /login.
        editor.addToHistory(redactLogin(text));
        add("user", redactLogin(text));
        turnAbort = new AbortController();
        phase = "evaluating";
        streamAt = undefined;
        streamedThisTurn = false;
        setBusy(true);
        try {
            const result = await runLine(text, state, { ...opts, abortSignal: turnAbort.signal }, confirm, (event) => {
                applyEvent(event);
                paintFooter();
                tui.requestRender();
            });
            endThinking();
            await applyChat(result);
            if (text.startsWith("/")) {
                refreshThinking();
                if (text.startsWith("/theme"))
                    paintTranscript();
                await refreshWelcome();
            }
            // The same notice (no key, local chat) is shown once, not after every turn.
            if (result.notice && result.notice !== lastNotice)
                add("system", result.notice);
            if (result.notice)
                lastNotice = result.notice;
            if (result.receipt) {
                // Streamed text is already on screen, block by block around the tool lines.
                if (!streamedThisTurn)
                    add("assistant", (result.receipt.answer ?? "").trim() || result.receipt.text);
                add("system", turnStatusLines(result.receipt).join("\n"));
            }
            else if (result.output)
                add("system", result.output);
            paintFooter();
            if (result.exit) {
                shutdown();
                return;
            }
        }
        catch (error) {
            add("system", turnAbort.signal.aborted
                ? "cancelled"
                : error instanceof Error
                    ? error.message
                    : String(error));
        }
        finally {
            // Read before setBusy clears it: a long turn rings when it ends (you may be in another window).
            if (turnStarted)
                ring("done", Date.now() - turnStarted);
            if (alive)
                setBusy(false);
            // The next queued message, if any (after this turn fully settled).
            const next = alive && !turnAbort.signal.aborted ? queued.shift() : undefined;
            showQueue();
            if (next)
                setTimeout(() => void submit(next), 0);
        }
    };
    function shutdown() {
        if (!alive)
            return;
        alive = false;
        closeState(state);
        turnAbort.abort();
        denyWaiters();
        if (elapsedTimer) {
            clearInterval(elapsedTimer);
            elapsedTimer = undefined;
        }
        terminal.setProgress(false);
        tui.stop();
        closed();
    }
    editor.onSubmit = (text) => {
        void submit(text);
    };
    tui.addInputListener((data) => {
        if (!alive)
            return { consume: true };
        // ctrl+t opens or folds reasoning (like Pi's thinking toggle); the choice is saved per project.
        // A deliberate "/think hide" stays hidden: ctrl+t does nothing until /think fold or /think show.
        if (matchesKey(data, Key.ctrl("t")) && !overlay) {
            if (thinkingDisplay === "hide")
                return { consume: true };
            thinkingDisplay = thinkingDisplay === "show" ? "fold" : "show";
            const loaded = loadSettingsSafe(cwd);
            if (!loaded.error)
                saveThinking(cwd, { display: thinkingDisplay });
            paintTranscript();
            return { consume: true };
        }
        // esc stops a running turn (at a y/N prompt the box itself treats esc as "no").
        if (matchesKey(data, Key.escape) && busy && !overlay) {
            turnAbort.abort();
            // Stopped: queued messages go back into the editor instead of running (Pi's choice, the safer one).
            if (queued.length) {
                const draft = editor.getText().trim();
                editor.setText([...queued.splice(0), draft].filter(Boolean).join("\n"));
                showQueue();
            }
            return { consume: true };
        }
        // shift+tab turns plan mode on or off (read-only until /plan go).
        if (matchesKey(data, Key.shift("tab")) && !overlay) {
            state.planMode = !state.planMode;
            add("system", state.planMode ? "plan mode on: read and search only · /plan go carries it out · shift+tab leaves" : "plan mode off");
            paintFooter();
            tui.requestRender();
            return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("c"))) {
            if (busy || overlay) {
                turnAbort.abort();
                denyWaiters();
                return { consume: true };
            }
            // Like Pi and Claude Code: first ctrl+c clears the prompt or arms exit, a second one exits.
            if (editor.getText().trim()) {
                editor.setText("");
                exitArmedAt = 0;
            }
            else if (exitArmedAt && Date.now() - exitArmedAt < 1500) {
                shutdown();
            }
            else {
                exitArmedAt = Date.now();
                setTimeout(() => {
                    if (alive) {
                        paintStatus();
                        tui.requestRender();
                    }
                }, 1600);
            }
            paintStatus();
            tui.requestRender();
            return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("d")) && !busy && !overlay && !editor.getText().trim()) {
            shutdown();
            return { consume: true };
        }
        return undefined;
    });
    await refreshWelcome();
    await loadConversation();
    showTodos(await currentTodos(state));
    paintFooter();
    tui.setFocus(editor);
    tui.start();
    return {
        tui,
        terminal,
        editor,
        feed: (data) => {
            if (terminal instanceof MemoryTerminal)
                terminal.feed(data);
        },
        shutdown,
        lines: () => tui.render(terminal.columns).map((line) => sanitizeText(line)),
        messages: () => log.map((item) => item.text),
        confirmText: () => lastConfirm,
        finished,
    };
}
export async function runTui(opts) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("TUI needs a real terminal. Use --repl for pipes.");
    }
    const app = await createTuiApp(opts);
    await app.finished;
}
