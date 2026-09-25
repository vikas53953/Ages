import {
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
import { APP_DIFFERENCE, APP_NAME, APP_TAGLINE, APP_VERSION } from "./brand.ts";
import { serializeConfirm } from "./confirm-queue.ts";
import { handleLine, startState, type HandleResult, type RunOpts } from "./runtime.ts";
import { loadMessages, messageText } from "./session.ts";
import { ConfirmBox } from "./tui-confirm.ts";
import { MemoryTerminal } from "./tui-memory.ts";
import {
  footerText,
  renderAssistantMessage,
  renderSystemMessage,
  renderUserMessage,
  sanitizeText,
  welcomeBanner,
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

  const header = new Text(
    welcomeBanner({
      name: APP_NAME,
      version: APP_VERSION,
      tagline: APP_TAGLINE,
      difference: APP_DIFFERENCE,
    }),
    0,
    0,
  );
  const transcript = new Text("", 0, 0);
  const log: { role: "user" | "assistant" | "system"; text: string }[] = [];
  let lastConfirm = "";
  const footer = new Text("", 0, 0);
  const editor = new Editor(tui, editorTheme, { paddingX: 0 });
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
      }),
    );
  };

  const paintTranscript = () => {
    const width = Math.max(20, terminal.columns - 2);
    const lines: string[] = [];
    for (const item of log) {
      if (item.role === "user") lines.push(...renderUserMessage(item.text, width));
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
      phase = "evaluating";
      add("system", "evaluating");
      return;
    }
    if (event.type === "route") {
      phase = "waiting for model";
      add("system", `model  ${event.model}`);
      return;
    }
    if (event.type === "waiting_model") {
      phase = "waiting for model";
      add("system", "waiting for model");
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
      add("system", phase);
      return;
    }
    if (event.type === "awaiting_approval") {
      phase = "awaiting approval";
      add("system", `awaiting approval  ${event.name}${event.target ? `  ${event.target}` : ""}`);
      return;
    }
    if (event.type === "tool") {
      const reason = event.record.deniedReason ? `  ${event.record.deniedReason}` : "";
      const target = event.record.target ? `  ${event.record.target}` : "";
      add("system", `${event.record.name}${target}  ${event.record.approved ? "ran" : "denied"}${reason}`);
      if (!event.record.approved && event.record.source === "agreement") phase = "blocked";
      return;
    }
    if (event.type === "text_delta") {
      phase = "waiting for model";
      const chunk = event.text;
      if (!chunk) return;
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
      add("system", `outcome  ${event.outcome}`);
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
    editor.addToHistory(text);
    add("user", text);
    turnAbort = new AbortController();
    phase = "evaluating";
    streamAt = undefined;
    if (!text.startsWith("/")) add("system", "accepted");
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
      if (result.notice) add("system", result.notice);
      if (result.receipt) {
        if (streamAt === undefined) add("assistant", result.receipt.text);
        else {
          log[streamAt] = { role: "assistant", text: result.receipt.text };
          paintTranscript();
        }
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
