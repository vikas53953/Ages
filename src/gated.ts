import { decideToolAction } from "./policy.ts";
import { raceAbort, waitForAbort } from "./abort.ts";
import { deliveryMutationBlock } from "./delivery.ts";
import type {
  ConfirmFn,
  GateConfig,
  JevClient,
  JsonObject,
  ToolDecision,
  ToolRecord,
  TurnEvent,
} from "./types.ts";
import { isGitRepo } from "./tools/fs.ts";

export type GatedRun = {
  output: string;
  record: ToolRecord;
  decision: ToolDecision;
};

const DISPLAY_LIMIT = 80_000;

function clipDisplay(text: string) {
  if (text.length <= DISPLAY_LIMIT) return text;
  return `${text.slice(0, DISPLAY_LIMIT)}\n  … [${text.length - DISPLAY_LIMIT} more bytes]`;
}

export function formatActionDiff(oldText: string, newText: string) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  return ["  --- old", "  +++ new", ...oldLines.map((line) => `  - ${line}`), ...newLines.map((line) => `  + ${line}`)].join(
    "\n",
  );
}

export function formatConfirm(name: string, args: JsonObject, decision: ToolDecision) {
  const details =
    name === "edit"
      ? [
          `  path: ${String(args.path ?? "")}`,
          clipDisplay(formatActionDiff(String(args.old_string ?? ""), String(args.new_string ?? ""))),
        ].join("\n")
      : Object.entries(args)
          .map(([key, value]) => `  ${key}: ${clipDisplay(String(value ?? ""))}`)
          .join("\n");
  return [
    `Aegis: ${name}  ${decision.class}  data_loss=${decision.dataLoss.toFixed(2)}  via ${decision.source}`,
    details,
    "[y/N] ",
  ]
    .filter(Boolean)
    .join("\n");
}

function cancelled(decision: ToolDecision, name: string): GatedRun {
  const record: ToolRecord = {
    name,
    class: decision.class,
    dataLoss: decision.dataLoss,
    confidence: decision.confidence,
    action: "deny",
    approved: false,
    deniedReason: "cancelled",
    source: decision.source,
  };
  return {
    output: JSON.stringify({
      denied: true,
      reason: "cancelled",
      class: decision.class,
    }),
    record,
    decision,
  };
}

export function toolTarget(name: string, args: JsonObject) {
  if (name === "shell") return String(args.command ?? "").slice(0, 120);
  return String(args.path ?? "");
}

export type TurnStop = {
  reason?: string;
};

export async function runGatedTool(input: {
  name: string;
  args: JsonObject;
  cwd: string;
  jev: JevClient;
  config: GateConfig;
  confirm: ConfirmFn;
  execute: () => Promise<string>;
  abortSignal?: AbortSignal;
  stop?: TurnStop;
  onEvent?: (event: TurnEvent) => void;
}): Promise<GatedRun> {
  const target = toolTarget(input.name, input.args);
  const emptyDecision: ToolDecision = {
    class: "irreversible",
    dataLoss: 1,
    confidence: 0,
    probabilities: { class: { read_only: 0, reversible: 0, irreversible: 1 } },
    source: "fail_closed",
  };
  if (input.stop?.reason) {
    const record: ToolRecord = {
      name: input.name,
      class: "irreversible",
      dataLoss: 1,
      confidence: 1,
      action: "deny",
      approved: false,
      deniedReason: input.stop.reason,
      target,
      source: "agreement",
    };
    return {
      output: JSON.stringify({ denied: true, reason: input.stop.reason, stopped: true, class: "irreversible" }),
      record,
      decision: emptyDecision,
    };
  }
  if (input.abortSignal?.aborted) {
    return cancelled(emptyDecision, input.name);
  }
  if (input.name === "write" || input.name === "edit" || input.name === "shell") {
    const block = await deliveryMutationBlock(input.cwd);
    if (block) {
      if (input.stop) input.stop.reason = block;
      return {
        output: JSON.stringify({ denied: true, reason: block, class: "irreversible" }),
        record: {
          name: input.name,
          class: "irreversible",
          dataLoss: 1,
          confidence: 1,
          action: "deny",
          approved: false,
          deniedReason: block,
          target,
          source: "agreement",
        },
        decision: emptyDecision,
      };
    }
  }
  const aborted = { kind: "abort" as const };
  const evaluation = await raceAbort(
    input.jev
      .evaluateTool(
        {
          name: input.name,
          args: input.args,
          cwd: input.cwd,
          git: isGitRepo(input.cwd),
        },
        input.abortSignal,
      )
      .then((decision) => ({ kind: "decision" as const, decision })),
    input.abortSignal,
    () => aborted,
  );
  if (evaluation.kind === "abort" || input.abortSignal?.aborted) {
    return cancelled(emptyDecision, input.name);
  }
  const decision = evaluation.decision;
  const action = decideToolAction(decision, input.config);
  const record: ToolRecord = {
    name: input.name,
    class: decision.class,
    dataLoss: decision.dataLoss,
    confidence: decision.confidence,
    action,
    approved: false,
    target,
    source: decision.source,
  };

  if (action === "deny") {
    record.deniedReason = "jev fail-closed";
    return {
      output: JSON.stringify({
        denied: true,
        reason: "jev fail-closed: mutations blocked until live Jev returns a valid class",
        class: decision.class,
      }),
      record,
      decision,
    };
  }

  if (action === "confirm") {
    input.onEvent?.({ type: "awaiting_approval", name: input.name, target });
    const prompt = formatConfirm(input.name, input.args, decision);
    const raced = await Promise.race([
      input.confirm(prompt).then((ok) => ({ kind: "answer" as const, ok })),
      waitForAbort(input.abortSignal).then(() => ({ kind: "abort" as const })),
    ]);
    if (raced.kind === "abort" || input.abortSignal?.aborted) {
      return cancelled(decision, input.name);
    }
    if (!raced.ok) {
      record.deniedReason = "user declined";
      return {
        output: JSON.stringify({
          denied: true,
          reason: "user declined",
          class: decision.class,
        }),
        record,
        decision,
      };
    }
  }

  if (input.abortSignal?.aborted) {
    return cancelled(decision, input.name);
  }

  record.approved = true;
  const output = await input.execute();
  return { output, record, decision };
}
