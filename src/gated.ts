import { decideToolAction, stricter } from "./policy.ts";
import { raceAbort, waitForAbort } from "./abort.ts";
import type { ToolGuard } from "./plugin-api.ts";
import { isMutation, loadSettingsSafe, matchRule, type RuleMatch, type Settings } from "./rules.ts";
import type {
  ConfirmFn,
  GateConfig,
  JevClient,
  JsonObject,
  PolicyAction,
  ToolDecision,
  ToolRecord,
  TurnEvent,
} from "./types.ts";
import { isGitRepo } from "./tools/fs.ts";

export type GatedRun = {
  output: string;
  record: ToolRecord;
  /** Jev's score, when Jev was asked. */
  decision?: ToolDecision;
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

export function formatConfirm(name: string, args: JsonObject, decision?: ToolDecision, why?: string) {
  const details =
    name === "edit"
      ? [
          `  path: ${String(args.path ?? "")}`,
          clipDisplay(formatActionDiff(String(args.old_string ?? ""), String(args.new_string ?? ""))),
        ].join("\n")
      : Object.entries(args)
          .map(([key, value]) => `  ${key}: ${clipDisplay(String(value ?? ""))}`)
          .join("\n");
  const score = decision
    ? `${decision.class}  data_loss=${decision.dataLoss.toFixed(2)}  via ${decision.source}`
    : "not scored by Jev";
  return [
    `Aegis: ${name}  ${score}`,
    why ? `  why: ${why}` : "",
    details,
    "[y/N] ",
  ]
    .filter(Boolean)
    .join("\n");
}

/** How a call looks when Jev did not score it: reads are read_only, anything that changes files counts as irreversible. */
function unscoredClass(name: string) {
  return isMutation(name) ? ("irreversible" as const) : ("read_only" as const);
}

function cancelled(decision: ToolDecision | undefined, name: string): GatedRun {
  const toolClass = decision?.class ?? unscoredClass(name);
  const record: ToolRecord = {
    name,
    class: toolClass,
    dataLoss: decision?.dataLoss ?? (isMutation(name) ? 1 : 0),
    confidence: decision?.confidence ?? 0,
    action: "deny",
    approved: false,
    deniedReason: "cancelled",
    source: decision?.source ?? "default",
  };
  return {
    output: JSON.stringify({
      denied: true,
      reason: "cancelled",
      class: toolClass,
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

function denied(input: { name: string; target: string; reason: string; source: ToolRecord["source"]; rule?: string }): GatedRun {
  return {
    output: JSON.stringify({ denied: true, reason: input.reason, class: "irreversible" }),
    record: {
      name: input.name,
      class: "irreversible",
      dataLoss: 1,
      confidence: 1,
      action: "deny",
      approved: false,
      deniedReason: input.reason,
      target: input.target,
      source: input.source,
      rule: input.rule,
    },
  };
}

/** Should Jev score this call? off: never. second-opinion: only when no rule matched. every-call: also every mutation a rule allows or asks about. */
export function wantsJev(settings: Settings, name: string, rule: RuleMatch | undefined) {
  const mode = settings.jev.mode;
  if (mode === "off") return false;
  if (!rule) return true;
  if (rule.action === "deny") return false;
  return mode === "every-call" && isMutation(name);
}

/** Who set the final action: the rule (unless Jev made it stricter), Jev, or nobody (default ask). */
function decidedBy(
  ruleAction: PolicyAction | undefined,
  jevAction: PolicyAction | undefined,
  decision: ToolDecision | undefined,
): ToolRecord["source"] {
  if (ruleAction && (!jevAction || stricter(ruleAction, jevAction) === ruleAction)) return "rule";
  if (decision) return decision.source;
  return "default";
}

/**
 * The checkpoint every tool call passes, in this order:
 * stop/cancel → plugin guards (delivery agreement) → rules (deny / ask / allow) → Jev (only if wanted) → you (default n) → run.
 */
export async function runGatedTool(input: {
  name: string;
  args: JsonObject;
  cwd: string;
  /** The scorer (Jev) from the plugin layer. None: rules and you decide alone. */
  jev?: JevClient;
  config: GateConfig;
  confirm: ConfirmFn;
  execute: () => Promise<string>;
  abortSignal?: AbortSignal;
  stop?: TurnStop;
  onEvent?: (event: TurnEvent) => void;
  settings?: Settings;
  /** Plugin checks that run before the rules (delivery agreement). */
  guards?: ToolGuard[];
}): Promise<GatedRun> {
  const target = toolTarget(input.name, input.args);
  if (input.stop?.reason) {
    const run = denied({ name: input.name, target, reason: input.stop.reason, source: "agreement" });
    run.output = JSON.stringify({ denied: true, reason: input.stop.reason, stopped: true, class: "irreversible" });
    return run;
  }
  if (input.abortSignal?.aborted) {
    return cancelled(undefined, input.name);
  }
  for (const guard of input.guards ?? []) {
    const block = await guard({ name: input.name, args: input.args, cwd: input.cwd });
    if (block) {
      if (input.stop) input.stop.reason = block;
      return denied({ name: input.name, target, reason: block, source: "agreement" });
    }
  }

  const loaded = input.settings ? { settings: input.settings } : loadSettingsSafe(input.cwd);
  const settings = loaded.settings;
  const rule = matchRule(settings, input.name, input.args);
  if (rule?.action === "deny") {
    return denied({ name: input.name, target, reason: `rule: ${rule.rule}`, source: "rule", rule: rule.rule });
  }

  let decision: ToolDecision | undefined;
  if (input.jev && wantsJev(settings, input.name, rule)) {
    const scorer = input.jev;
    const evaluation = await raceAbort(
      scorer
        .evaluateTool(
          {
            name: input.name,
            args: input.args,
            cwd: input.cwd,
            git: isGitRepo(input.cwd),
          },
          input.abortSignal,
        )
        .then((scored) => ({ kind: "decision" as const, decision: scored })),
      input.abortSignal,
      () => ({ kind: "abort" as const }),
    );
    if (evaluation.kind === "abort" || input.abortSignal?.aborted) {
      return cancelled(undefined, input.name);
    }
    decision = evaluation.decision;
  }

  const ruleAction: PolicyAction | undefined =
    rule?.action === "allow" ? "auto" : rule?.action === "ask" ? "confirm" : undefined;
  const jevAction = decision ? decideToolAction(decision, input.config) : undefined;
  // A rule decides; Jev may only make it stricter. No rule and no Jev: ask.
  const action: PolicyAction = ruleAction
    ? jevAction
      ? stricter(ruleAction, jevAction)
      : ruleAction
    : (jevAction ?? "confirm");

  const why = [
    rule ? `rule "${rule.rule}" → ${rule.action}` : "no rule matched",
    decision
      ? `Jev ${decision.source === "fail_closed" ? "could not score" : `→ ${jevAction}`}`
      : `Jev ${settings.jev.mode === "off" || !input.jev ? "off" : "not asked"}`,
    loaded.error ? `settings unreadable (${loaded.error}); allow rules ignored, Jev off` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const record: ToolRecord = {
    name: input.name,
    class: decision?.class ?? unscoredClass(input.name),
    dataLoss: decision?.dataLoss ?? (isMutation(input.name) ? 1 : 0),
    confidence: decision?.confidence ?? (rule ? 1 : 0),
    action,
    approved: false,
    target,
    source: decidedBy(ruleAction, jevAction, decision),
    rule: rule?.rule,
  };

  if (action === "confirm") {
    input.onEvent?.({ type: "awaiting_approval", name: input.name, target });
    const prompt = formatConfirm(input.name, input.args, decision, why);
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
          class: record.class,
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
