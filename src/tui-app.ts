import {
  CombinedAutocompleteProvider,
  Editor,
  getKeybindings,
  isViewportTUI,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  type TUI,
  type Terminal,
  VStack,
} from "@earendil-works/pi-tui";
import { HELP, slashCommandsFromHelp } from "./commands.ts";
import { serializeConfirm } from "./confirm-queue.ts";
import { handleLine, startState, welcomeInfo, type HandleResult, type RunOpts } from "./runtime.ts";
import { shortPath, welcomeLines, type WelcomeInfo } from "./welcome.ts";
import { redactLogin } from "./login.ts";
import { loadMessages, messageText } from "./session.ts";
import { ConfirmBox } from "./tui-confirm.ts";
import { MemoryTerminal } from "./tui-memory.ts";
import {
  footerText,
  renderAssistantMessage,
  renderSystemMessage,
  renderToolLine,
  renderUserMessage,
  sanitizeText,
  turnStatusLines,
  type ToolStatus,
} from "./tui-layout.ts";
import type { ConfirmFn } from "./types.ts";
import type { TurnEvent } from "./loop.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const editorTheme = {
  borderColor: dim,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
};

type LineHandler = typeof handleLine;

export type TuiApp = {
  tui: TUI;
  terminal: Terminal;
  editor: Editor;
  feed: (data: string) => void;
  shutdown: () => void;
  lines: () => string[];
  messages: () => string[];
  confirmText: () => string;
  finished: Promise<void>;
};

export async function createTuiApp(
  opts: RunOpts,
  input: {
    cwd?: string;
    terminal?: Terminal;
    handleLine?: LineHandler;
  } = {},
): Promise<TuiApp> {
  const cwd = input.cwd ?? process.cwd();
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
  let welcome: WelcomeInfo | undefined;
  const header = {
    render: (width: number) => (welcome ? welcomeLines(welcome, width, !input.terminal || !(input.terminal instanceof MemoryTerminal)) : []),
    invalidate: () => {},
  };
  const refreshWelcome = async () => {
    welcome = await welcomeInfo(state);
    tui.requestRender();
  };
  const transcript = new Text("", 0, 0);
  type LogItem = {
    role: "user" | "assistant" | "system" | "tool";
    text: string;
    status?: ToolStatus;
    detail?: string;
    key?: string;
  };
  const log: LogItem[] = [];
  let lastNotice = "";
  let streamedThisTurn = false;
  let lastConfirm = "";
  const footer = new Text("", 0, 0);
  const editor = new Editor(tui, editorTheme, { paddingX: 0 });
  // Type / for commands (core + plugins), @ for files — the same pi-tui provider Pi uses.
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      slashCommandsFromHelp([...HELP.split("\n"), ...state.plugins.flatMap((plugin) => plugin.help ?? [])]),
      cwd,
    ),
  );
  const dock = new VStack([editor, footer]);
  const scroll = new ScrollView(new VStack([header, transcript]), {
    follow: "end",
    primary: true,
    overscroll: "chain",
    scrollbar: "auto",
  });

  if (!isViewportTUI(tui)) {
    throw new Error("Aegis TUI needs an application-owned viewport.");
  }
  tui.setLayoutRoot(
    new VStack([
      { component: scroll, basis: 0, grow: 1, minSize: 3 },
      { component: dock, basis: "auto", shrink: 0, minSize: 4 },
    ]),
  );

  let busy = false;
  let alive = true;
  let phase = "idle";
  let turnStarted = 0;
  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  let streamAt: number | undefined;
  let turnAbort = new AbortController();
  let overlay: { hide: () => void } | undefined;
  const pendingConfirms: Array<(ok: boolean) => void> = [];
  let closed: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    closed = resolve;
  });

  const paintFooter = () => {
    footer.setText(
      footerText({
        modelMode: state.modelMode,
        model: state.model,
        jev: state.jevHealth,
        provider: state.provider,
        busy,
        phase: busy ? phase : undefined,
        elapsedMs: busy && turnStarted ? Date.now() - turnStarted : 0,
        task: state.taskPermission,
        cwd: shortPath(cwd, Math.max(12, Math.floor(terminal.columns / 4))),
      }),
    );
  };

  const paintTranscript = () => {
    const width = Math.max(20, terminal.columns - 2);
    const lines: string[] = [];
    for (const item of log) {
      if (item.role === "user") lines.push(...renderUserMessage(item.text, width));
      else if (item.role === "tool") lines.push(...renderToolLine({ text: item.text, status: item.status ?? "pending", detail: item.detail }, width));
      else if (item.role === "assistant") lines.push(...renderAssistantMessage(item.text, width));
      else lines.push(...renderSystemMessage(item.text, width));
      lines.push("");
    }
    transcript.setText(lines.join("\n").trimEnd());
    scroll.scrollToEnd();
    tui.requestRender();
  };

  const add = (role: "user" | "assistant" | "system", text: string) => {
    const clean = sanitizeText(text).trim();
    if (!clean) return;
    log.push({ role, text: clean });
    paintTranscript();
  };

  const loadConversation = async () => {
    log.length = 0;
    const history = await loadMessages(cwd, state.session.id);
    for (const message of history) {
      if (message.role === "tool") continue;
      const text = messageText(message);
      if (/Paste OPENCODE_API_KEY|No chat key this run|Local planner only/.test(text)) {
        continue;
      }
      add(message.role === "user" ? "user" : "assistant", text);
    }
    paintTranscript();
  };

  const confirm: ConfirmFn = serializeConfirm(
    (question) =>
      new Promise<boolean>((resolve) => {
        lastConfirm = question;
        overlay?.hide();
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          const at = pendingConfirms.indexOf(finish);
          if (at >= 0) pendingConfirms.splice(at, 1);
          overlay?.hide();
          overlay = undefined;
          editor.disableSubmit = busy;
          tui.setFocus(editor);
          resolve(ok);
          tui.requestRender();
        };
        pendingConfirms.push(finish);
        editor.disableSubmit = true;
        overlay = tui.showOverlay(new ConfirmBox(question, finish, terminal.rows), {
          anchor: "bottom-center",
          width: "96%",
          maxHeight: "80%",
          margin: 1,
        });
        tui.requestRender();
      }),
  );

  const denyWaiters = () => {
    overlay?.hide();
    overlay = undefined;
    while (pendingConfirms.length) pendingConfirms.shift()?.(false);
    editor.disableSubmit = busy;
    if (alive) tui.setFocus(editor);
  };

  const setBusy = (next: boolean) => {
    busy = next;
    editor.disableSubmit = next || Boolean(overlay);
    terminal.setProgress(next);
    if (next) {
      turnStarted = Date.now();
      elapsedTimer ??= setInterval(() => {
        if (!alive) return;
        paintFooter();
        tui.requestRender();
      }, 250);
    } else {
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

  const applyEvent = (event: TurnEvent) => {
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
      if (event.reason !== "selected") add("system", `model ${event.model} · ${event.reason}`);
      return;
    }
    if (event.type === "waiting_model") {
      phase = "waiting for model";
      return;
    }
    if (event.type === "tool_start") {
      const verb =
        event.name === "read"
          ? "reading"
          : event.name === "edit"
            ? "editing"
            : event.name === "write"
              ? "writing"
              : event.name === "grep"
                ? "searching"
                : event.name;
      phase = event.target ? `${verb} ${event.target}` : verb;
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
        ? `${record.action === "confirm" ? "you said yes" : "auto"} · ${decidedBy}`
        : `denied · ${record.deniedReason ?? "no reason"}`;
      if (item) {
        item.status = record.approved ? "ran" : "denied";
        item.detail = detail;
      } else {
        log.push({ role: "tool", text: `${record.name}${record.target ? ` ${record.target}` : ""}`, status: record.approved ? "ran" : "denied", detail });
      }
      if (!record.approved && record.source === "agreement") phase = "blocked";
      paintTranscript();
      return;
    }
    if (event.type === "text_delta") {
      phase = "waiting for model";
      const chunk = event.text;
      if (!chunk) return;
      streamedThisTurn = true;
      if (streamAt === undefined) {
        log.push({ role: "assistant", text: chunk });
        streamAt = log.length - 1;
      } else {
        const current = log[streamAt];
        if (current) current.text += chunk;
      }
      paintTranscript();
      return;
    }
    if (event.type === "outcome") {
      phase = event.outcome === "completed" ? "finished" : event.outcome;
    }
  };

  const applyChat = async (result: HandleResult) => {
    if (result.chat === "reset") {
      log.length = 0;
      paintTranscript();
      return;
    }
    if (result.chat === "reload") {
      await loadConversation();
    }
  };

  const submit = async (line: string) => {
    const text = line.trim();
    if (!alive || busy || !text) return;
    editor.setText("");
    // Never echo or keep an API key typed with /login.
    editor.addToHistory(redactLogin(text));
    add("user", redactLogin(text));
    turnAbort = new AbortController();
    phase = "evaluating";
    streamAt = undefined;
    streamedThisTurn = false;
    setBusy(true);
    try {
      const result = await runLine(
        text,
        state,
        { ...opts, abortSignal: turnAbort.signal },
        confirm,
        (event) => {
          applyEvent(event);
          paintFooter();
          tui.requestRender();
        },
      );
      await applyChat(result);
      if (text.startsWith("/")) await refreshWelcome();
      // The same notice (no key, local chat) is shown once, not after every turn.
      if (result.notice && result.notice !== lastNotice) add("system", result.notice);
      if (result.notice) lastNotice = result.notice;
      if (result.receipt) {
        // Streamed text is already on screen, block by block around the tool lines.
        if (!streamedThisTurn) add("assistant", (result.receipt.answer ?? "").trim() || result.receipt.text);
        add("system", turnStatusLines(result.receipt).join("\n"));
      } else if (result.output) add("system", result.output);
      paintFooter();
      if (result.exit) {
        shutdown();
        return;
      }
    } catch (error) {
      add(
        "system",
        turnAbort.signal.aborted
          ? "cancelled"
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      if (alive) setBusy(false);
    }
  };

  function shutdown() {
    if (!alive) return;
    alive = false;
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
    if (!alive) return { consume: true };
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
      if (busy || overlay) {
        turnAbort.abort();
        denyWaiters();
        return { consume: true };
      }
      shutdown();
      return { consume: true };
    }
    return undefined;
  });

  await refreshWelcome();
  await loadConversation();
  paintFooter();
  tui.setFocus(editor);
  tui.start();

  return {
    tui,
    terminal,
    editor,
    feed: (data: string) => {
      if (terminal instanceof MemoryTerminal) terminal.feed(data);
    },
    shutdown,
    lines: () => tui.render(terminal.columns).map((line) => sanitizeText(line)),
    messages: () => log.map((item) => item.text),
    confirmText: () => lastConfirm,
    finished,
  };
}

export async function runTui(opts: RunOpts) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI needs a real terminal. Use --repl for pipes.");
  }
  const app = await createTuiApp(opts);
  await app.finished;
}
