import { loadEnv, hasJevCredentials } from "./env.ts";
import { liveJev } from "./jev/evaluate.ts";
import { mockJev } from "./jev/mock.ts";
import { formatReceipt, localGenerate, runLoop, type GenerateFn, type TurnEvent } from "./loop.ts";
import { formatChat } from "./receipt.ts";
import { resolveProvider, type ChatProvider } from "./providers.ts";
import { HELP, isExactYes, parseLine } from "./commands.ts";
import { addMemory, loadMemory } from "./memory.ts";
import { loadSkills } from "./skills.ts";
import { loadContext } from "./context.ts";
import { compactSession } from "./compact.ts";
import { buildSystemPrompt } from "./system.ts";
import { currentCatalog, formatModelList, refreshCatalog } from "./catalog.ts";
import { clearPinnedModel, defaultModelId, loadPinnedModel, setPinnedModel } from "./model-pin.ts";
import {
  createSession,
  listSessions,
  loadMessages,
  loadOrCreateSession,
  switchSession,
  appendMessage,
  type SessionMeta,
} from "./session.ts";
import type { ConfirmFn, JevHealth, Receipt, TaskPermission } from "./types.ts";
import {
  acceptTask,
  agreementFromOwnerText,
  clearConversationalPending,
  clearPendingConfirm,
  clearPendingDraft,
  confirmAgreement,
  formatTaskStatus,
  formatTaskSystemPrompt,
  loadTask,
  proposeNewTask,
  readPendingConfirm,
  readPendingDraft,
  renderProposalReview,
  renderTaskCard,
  taskPermission,
  writePendingDraft,
} from "./delivery.ts";
import { formatPlan, loadPlan, openTestedResult, runDeliveryBuild } from "./controller.ts";
import { loadSettingsSafe, parseJevMode, saveJevMode, settingsPath, type JevMode } from "./rules.ts";

export type RunOpts = {
  mockJev: boolean;
  yes: boolean;
  local?: boolean;
  model?: string;
  abortSignal?: AbortSignal;
  generate?: GenerateFn;
};

export type AppState = {
  cwd: string;
  session: SessionMeta;
  provider: ChatProvider;
  model: string;
  modelMode: "auto" | "pinned";
  jevHealth: JevHealth;
  taskPermission: TaskPermission;
};

export type HandleResult = {
  exit?: boolean;
  output: string;
  notice?: string;
  session: SessionMeta;
  receipt?: Receipt;
  chat?: "keep" | "reset" | "reload";
};

export function initialJevHealth(mockJev: boolean, mode: JevMode = "second-opinion"): JevHealth {
  if (mode === "off") return "off";
  if (mockJev) return "mock";
  return hasJevCredentials() ? "down" : "blocked";
}

export function jevHealthFromReceipt(mockJev: boolean, receipt: Receipt): JevHealth {
  if (receipt.turn.source === "off") return "off";
  if (mockJev) return "mock";
  if (!hasJevCredentials()) return "blocked";
  if (receipt.turn.source === "fail_closed") return "down";
  if (receipt.tools.some((tool) => tool.source === "fail_closed")) return "down";
  if (receipt.tools.some((tool) => tool.source === "agreement")) {
    return receipt.turn.source === "jev" ? "live" : receipt.turn.source === "mock" ? "mock" : "live";
  }
  if (receipt.turn.source === "jev") return "live";
  if (receipt.turn.source === "mock") return "mock";
  return "down";
}

export async function startState(
  cwd: string,
  opts: { local?: boolean; model?: string; mockJev?: boolean },
): Promise<AppState> {
  const session = await loadOrCreateSession(cwd);
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
  const jevHealth = initialJevHealth(opts.mockJev === true, loadSettingsSafe(cwd).settings.jev.mode);
  await clearConversationalPending(cwd);
  const permission = await taskPermission(cwd);
  if (pinned) {
    return { cwd, session, provider, model: pinned, modelMode: "pinned", jevHealth, taskPermission: permission };
  }
  return { cwd, session, provider, model: "auto", modelMode: "auto", jevHealth, taskPermission: permission };
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
  const jev = opts.mockJev ? mockJev() : liveJev();
  const loadedSettings = loadSettingsSafe(state.cwd);
  const notice = [
    useLocal ? "Chat is local (no OpenCode key). I can list, read, and search." : "",
    loadedSettings.error
      ? `Settings unreadable (${loadedSettings.error}). Jev is off and allow rules are ignored until you fix ${settingsPath(state.cwd)}.`
      : "",
    !opts.mockJev && !hasJevCredentials() && loadedSettings.settings.jev.mode !== "off"
      ? "Jev has no key. Rules still apply; anything Jev would score asks you instead. /jev off hides this."
      : "",
  ]
    .filter(Boolean)
    .join("\n") || undefined;
  const session = await loadOrCreateSession(state.cwd);
  const history = await loadMessages(state.cwd, session.id);
  const memory = await loadMemory(state.cwd);
  const skills = await loadSkills(state.cwd);
  const context = await loadContext(state.cwd);
  const taskContext = await formatTaskSystemPrompt(state.cwd);
  const at = new Date().toISOString();
  await appendMessage(state.cwd, session.id, { role: "user", content: prompt, at });
  onEvent?.({ type: "accepted" });
  const receipt = await runLoop({
    prompt,
    cwd: state.cwd,
    jev,
    config,
    confirm,
    sessionId: session.id,
    generate: opts.generate ?? (useLocal ? localGenerate : undefined),
    system: [
      buildSystemPrompt({ cwd: state.cwd, memory, skills, context }),
      "Task records (authoritative). Chat is not a stored agreement.",
      taskContext,
      "Do not ask the owner to reply yes. The supported confirm action is /task confirm <id> <hash>, or yes only while a pending confirm for that exact hash is shown in this session. /task new <id> proposes a different task and does not overwrite another. Never mark owner acceptance.",
    ].join("\n\n"),
    history,
    provider,
    model: state.modelMode === "pinned" ? state.model : undefined,
    abortSignal: opts.abortSignal,
    onEvent,
  });
  await appendMessage(state.cwd, session.id, {
    role: "assistant",
    content: receipt.text,
    at: new Date().toISOString(),
  });
  state.jevHealth = jevHealthFromReceipt(opts.mockJev, receipt);
  state.taskPermission = receipt.taskPermission ?? (await taskPermission(state.cwd));
  return {
    output: formatReceipt(receipt),
    notice,
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
  const cmd = parseLine(line);
  if (cmd.type === "empty") {
    return { output: "", session: state.session };
  }
  if (cmd.type === "exit") {
    return { exit: true, output: "", session: state.session };
  }
  if (cmd.type === "help") {
    return { output: HELP, session: state.session };
  }
  if (cmd.type === "new" || cmd.type === "clear") {
    await clearConversationalPending(state.cwd);
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
    const result = await compactSession(state.cwd, state.session.id);
    return {
      output: result.summarized
        ? `compacted ${result.summarized} messages, kept ${result.kept}`
        : "nothing to compact",
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
  if (cmd.type === "jev") {
    const loaded = loadSettingsSafe(state.cwd);
    if (cmd.mode) {
      const mode = parseJevMode(cmd.mode);
      if (!mode) return { output: "usage: /jev off | second | every", session: state.session };
      if (loaded.error) {
        return { output: `Fix ${settingsPath(state.cwd)} first: ${loaded.error}`, session: state.session };
      }
      saveJevMode(state.cwd, mode);
      state.jevHealth = initialJevHealth(opts.mockJev === true, mode);
      return { output: `jev mode ${mode}  (saved to ${settingsPath(state.cwd)})`, session: state.session };
    }
    return {
      output: [
        `jev mode  ${loaded.settings.jev.mode}${loaded.error ? `  (settings unreadable: ${loaded.error})` : ""}`,
        `jev key   ${hasJevCredentials() ? "present" : "missing"}`,
        `settings  ${settingsPath(state.cwd)}`,
        "modes     off · second (only calls no rule matches) · every (also every write/edit/shell)",
      ].join("\n"),
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
        `cwd       ${state.cwd}`,
      ].join("\n"),
      session: state.session,
    };
  }
  if (cmd.type === "task") {
    try {
      if (cmd.action === "new") {
        if (!cmd.id) return { output: "usage: /task new <id>", session: state.session };
        await clearPendingConfirm(state.cwd);
        await writePendingDraft(state.cwd, {
          id: cmd.id,
          sessionId: state.session.id,
          at: new Date().toISOString(),
        });
        state.taskPermission = await taskPermission(state.cwd);
        return {
          output: [
            `Next message becomes the proposed agreement for '${cmd.id}'.`,
            "The active task is unchanged. Existing tasks are not overwritten.",
            await formatTaskStatus(state.cwd, state.session.id),
          ].join("\n"),
          session: state.session,
        };
      }
      if (cmd.action === "confirm") {
        await confirmAgreement(
          state.cwd,
          "owner",
          cmd.id ? { id: cmd.id, fingerprint: cmd.fingerprint } : undefined,
        );
        state.taskPermission = await taskPermission(state.cwd);
        return { output: await renderTaskCard(state.cwd, state.session.id), session: state.session };
      }
      if (cmd.action === "accept") {
        await acceptTask(state.cwd, "owner");
        state.taskPermission = await taskPermission(state.cwd);
        return { output: await renderTaskCard(state.cwd, state.session.id), session: state.session };
      }
      if (cmd.action === "build") {
        const built = await runDeliveryBuild({
          cwd: state.cwd,
          sessionId: state.session.id,
          mockJev: opts.mockJev,
          local: opts.local,
          generate: opts.generate,
          confirm: opts.yes ? async () => true : confirm,
          provider: state.provider,
          model: state.modelMode === "pinned" ? state.model : undefined,
          abortSignal: opts.abortSignal,
          onEvent,
        });
        state.taskPermission = await taskPermission(state.cwd);
        return { output: built.output, session: state.session };
      }
      if (cmd.action === "open") {
        return { output: await openTestedResult(state.cwd), session: state.session };
      }
      const pendingReview = await readPendingConfirm(state.cwd, state.session.id);
      if (pendingReview) {
        return { output: await renderProposalReview(state.cwd, pendingReview.slot), session: state.session };
      }
      const card = await renderTaskCard(state.cwd, state.session.id);
      const active = await loadTask(state.cwd).catch(() => undefined);
      const plan = active ? await loadPlan(state.cwd, active) : undefined;
      return {
        output: plan ? `${card}\n\n${formatPlan(plan)}` : card,
        session: state.session,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        session: state.session,
      };
    }
  }
  if (cmd.type !== "prompt") {
    return { output: "", session: state.session };
  }
  const draft = await readPendingDraft(state.cwd, state.session.id);
  if (draft) {
    try {
      const proposed = await proposeNewTask(
        state.cwd,
        agreementFromOwnerText(draft.id, cmd.text),
        state.session.id,
      );
      state.taskPermission = await taskPermission(state.cwd);
      const review = await renderProposalReview(state.cwd, proposed.slot);
      await appendMessage(state.cwd, state.session.id, {
        role: "user",
        content: cmd.text,
        at: new Date().toISOString(),
      });
      await appendMessage(state.cwd, state.session.id, {
        role: "assistant",
        content: review,
        at: new Date().toISOString(),
      });
      return {
        output: [
          `Proposed '${proposed.agreement.id}' hash ${proposed.fingerprint}. Active task was not overwritten.`,
          review,
        ].join("\n"),
        session: state.session,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        session: state.session,
      };
    }
  }
  if (isExactYes(cmd.text)) {
    const pending = await readPendingConfirm(state.cwd, state.session.id);
    if (pending) {
      try {
        await confirmAgreement(state.cwd, "owner", {
          id: pending.id,
          fingerprint: pending.fingerprint,
        });
        state.taskPermission = await taskPermission(state.cwd);
        return { output: await renderTaskCard(state.cwd, state.session.id), session: state.session };
      } catch (error) {
        return {
          output: error instanceof Error ? error.message : String(error),
          session: state.session,
        };
      }
    }
    const task = await loadTask(state.cwd).catch(() => undefined);
    if (task && task.agreement.status !== "confirmed") {
      return {
        output: [
          `Plain yes did not confirm '${task.agreement.id}' hash ${task.fingerprint}.`,
          "That would enter a blocked generation loop. Confirm the displayed agreement with /task confirm, or /task new <id> for a different task.",
          await formatTaskStatus(state.cwd, state.session.id),
        ].join("\n"),
        session: state.session,
      };
    }
  }
  const leftoverPending = await readPendingConfirm(state.cwd, state.session.id);
  if (leftoverPending) await clearPendingConfirm(state.cwd);
  const leftoverDraft = await readPendingDraft(state.cwd, state.session.id);
  if (leftoverDraft) await clearPendingDraft(state.cwd);
  const ran = await runPrompt(cmd.text, state, opts, confirm, onEvent);
  state.session = ran.session;
  return {
    output: ran.receipt ? formatChat(ran.receipt) : ran.output,
    notice: ran.notice,
    session: ran.session,
    receipt: ran.receipt,
  };
}
