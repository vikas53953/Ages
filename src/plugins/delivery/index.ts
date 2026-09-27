import { isExactYes } from "../../commands.ts";
import type { AegisPlugin, CommandContext } from "../../plugin-api.ts";
import { isMutation } from "../../rules.ts";
import type { HandleResult } from "../../runtime.ts";
import { appendMessage } from "../../session.ts";
import { formatPlan, loadPlan, openTestedResult, runDeliveryBuild } from "./controller.ts";
import {
  acceptTask,
  agreementFromOwnerText,
  clearConversationalPending,
  clearPendingConfirm,
  clearPendingDraft,
  confirmAgreement,
  deliveryMutationBlock,
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

export type TaskCommand = {
  action?: "confirm" | "accept" | "new" | "build" | "open";
  id?: string;
  fingerprint?: string;
};

/** Parse the words after /task. Undefined means "not a task command": the line goes to the model instead. */
export function parseTaskArg(arg: string): TaskCommand | undefined {
  if (!arg) return {};
  if (/^new$/i.test(arg)) return { action: "new" };
  if (/^new\s+/i.test(arg)) return { action: "new", id: arg.slice(4).trim() };
  if (/^confirm$/i.test(arg)) return { action: "confirm" };
  if (/^confirm\s+/i.test(arg)) {
    const parts = arg.slice(8).trim().split(/\s+/);
    return { action: "confirm", id: parts[0], fingerprint: parts[1] };
  }
  if (/^accept$/i.test(arg)) return { action: "accept" };
  if (/^build$/i.test(arg)) return { action: "build" };
  if (/^open$/i.test(arg)) return { action: "open" };
  return undefined;
}

function reply(ctx: CommandContext, output: string): HandleResult {
  return { output, session: ctx.state.session };
}

async function taskCommand(cmd: TaskCommand, ctx: CommandContext): Promise<HandleResult> {
  const { state, opts, confirm, onEvent } = ctx;
  try {
    if (cmd.action === "new") {
      if (!cmd.id) return reply(ctx, "usage: /task new <id>");
      await clearPendingConfirm(state.cwd);
      await writePendingDraft(state.cwd, {
        id: cmd.id,
        sessionId: state.session.id,
        at: new Date().toISOString(),
      });
      state.taskPermission = await taskPermission(state.cwd);
      return reply(
        ctx,
        [
          `Next message becomes the proposed agreement for '${cmd.id}'.`,
          "The active task is unchanged. Existing tasks are not overwritten.",
          await formatTaskStatus(state.cwd, state.session.id),
        ].join("\n"),
      );
    }
    if (cmd.action === "confirm") {
      await confirmAgreement(state.cwd, "owner", cmd.id ? { id: cmd.id, fingerprint: cmd.fingerprint } : undefined);
      state.taskPermission = await taskPermission(state.cwd);
      return reply(ctx, await renderTaskCard(state.cwd, state.session.id));
    }
    if (cmd.action === "accept") {
      await acceptTask(state.cwd, "owner");
      state.taskPermission = await taskPermission(state.cwd);
      return reply(ctx, await renderTaskCard(state.cwd, state.session.id));
    }
    if (cmd.action === "build") {
      const built = await runDeliveryBuild({
        cwd: state.cwd,
        sessionId: state.session.id,
        plugins: state.plugins,
        local: opts.local,
        generate: opts.generate,
        confirm: opts.yes ? async () => true : confirm,
        provider: state.provider,
        model: state.modelMode === "pinned" ? state.model : undefined,
        abortSignal: opts.abortSignal,
        onEvent,
      });
      state.taskPermission = await taskPermission(state.cwd);
      return reply(ctx, built.output);
    }
    if (cmd.action === "open") {
      return reply(ctx, await openTestedResult(state.cwd));
    }
    const pendingReview = await readPendingConfirm(state.cwd, state.session.id);
    if (pendingReview) {
      return reply(ctx, await renderProposalReview(state.cwd, pendingReview.slot));
    }
    const card = await renderTaskCard(state.cwd, state.session.id);
    const active = await loadTask(state.cwd).catch(() => undefined);
    const plan = active ? await loadPlan(state.cwd, active) : undefined;
    return reply(ctx, plan ? `${card}\n\n${formatPlan(plan)}` : card);
  } catch (error) {
    return reply(ctx, error instanceof Error ? error.message : String(error));
  }
}

/** A pending /task new draft turns the next message into a proposed agreement; a plain "yes" confirms only a shown proposal. */
async function interceptPrompt(text: string, ctx: CommandContext): Promise<HandleResult | undefined> {
  const { state } = ctx;
  const draft = await readPendingDraft(state.cwd, state.session.id);
  if (draft) {
    try {
      const proposed = await proposeNewTask(state.cwd, agreementFromOwnerText(draft.id, text), state.session.id);
      state.taskPermission = await taskPermission(state.cwd);
      const review = await renderProposalReview(state.cwd, proposed.slot);
      await appendMessage(state.cwd, state.session.id, { role: "user", content: text, at: new Date().toISOString() });
      await appendMessage(state.cwd, state.session.id, {
        role: "assistant",
        content: review,
        at: new Date().toISOString(),
      });
      return reply(
        ctx,
        [`Proposed '${proposed.agreement.id}' hash ${proposed.fingerprint}. Active task was not overwritten.`, review].join(
          "\n",
        ),
      );
    } catch (error) {
      return reply(ctx, error instanceof Error ? error.message : String(error));
    }
  }
  if (isExactYes(text)) {
    const pending = await readPendingConfirm(state.cwd, state.session.id);
    if (pending) {
      try {
        await confirmAgreement(state.cwd, "owner", { id: pending.id, fingerprint: pending.fingerprint });
        state.taskPermission = await taskPermission(state.cwd);
        return reply(ctx, await renderTaskCard(state.cwd, state.session.id));
      } catch (error) {
        return reply(ctx, error instanceof Error ? error.message : String(error));
      }
    }
    const task = await loadTask(state.cwd).catch(() => undefined);
    if (task && task.agreement.status !== "confirmed") {
      return reply(
        ctx,
        [
          `Plain yes did not confirm '${task.agreement.id}' hash ${task.fingerprint}.`,
          "That would enter a blocked generation loop. Confirm the displayed agreement with /task confirm, or /task new <id> for a different task.",
          await formatTaskStatus(state.cwd, state.session.id),
        ].join("\n"),
      );
    }
  }
  return undefined;
}

const onTask = async (arg: string, ctx: CommandContext): Promise<HandleResult> => {
  const cmd = parseTaskArg(arg);
  return cmd ? taskCommand(cmd, ctx) : reply(ctx, `unknown /task command: ${arg}. /help lists them.`);
};

/**
 * delivery plugin: task agreement → evidence → delivery card → owner acceptance.
 * Blocks file changes while the active agreement is only proposed.
 */
export function deliveryPlugin(): AegisPlugin {
  return {
    name: "delivery",
    help: [
      "  /task              active task, pending confirm, delivery card",
      "  /task new <id>     next message proposes that task; does not overwrite others",
      "  /task confirm      confirm the displayed pending agreement, or active if none",
      "  /task confirm <id> <hash>  confirm that exact version only",
      "  /task accept       owner accepts delivery (explicit)",
      "  /task build        run the delivery loop for the confirmed inventory task",
      "  /task open         open the tested result if evidence is still bound",
    ],
    commands: { task: onTask, card: onTask, delivery: onTask },
    guardTool: async (call) => (isMutation(call.name) ? deliveryMutationBlock(call.cwd) : undefined),
    systemPrompt: async ({ cwd }) =>
      [
        "Task records (authoritative). Chat is not a stored agreement.",
        await formatTaskSystemPrompt(cwd),
        "Do not ask the owner to reply yes. The supported confirm action is /task confirm <id> <hash>, or yes only while a pending confirm for that exact hash is shown in this session. /task new <id> proposes a different task and does not overwrite another. Never mark owner acceptance.",
      ].join("\n\n"),
    beforePrompt: interceptPrompt,
    beforeTurn: async ({ state }) => {
      if (await readPendingConfirm(state.cwd, state.session.id)) await clearPendingConfirm(state.cwd);
      if (await readPendingDraft(state.cwd, state.session.id)) await clearPendingDraft(state.cwd);
    },
    turnEnd: async ({ cwd, stopReason, outcome }) => {
      const task = await loadTask(cwd).catch(() => undefined);
      return {
        taskId: task?.agreement.id,
        taskFingerprint: task?.fingerprint,
        taskPermission: await taskPermission(cwd),
        next: stopReason
          ? "Confirm the displayed agreement, or /task new <id> for a different task. Do not reply yes unless a pending confirm is shown."
          : outcome === "incomplete"
            ? undefined
            : "Review the card with /task. Only you can /task accept.",
      };
    },
    onSessionStart: clearConversationalPending,
    taskPermission,
  };
}
