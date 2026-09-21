import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import {
  INVENTORY_ACCEPTANCE,
  INVENTORY_TASK_ID,
  captureIdentity,
  formatTaskSystemPrompt,
  isVerifiedCheck,
  loadTask,
  readSlotJson,
  recordMissing,
  renderCard,
  runCheck,
  setDeliveryFlags,
  writeSlotJson,
  type TaskRecord,
} from "./delivery.ts";
import { packageRoot } from "./env.ts";
import { liveJev } from "./jev/evaluate.ts";
import { mockJev } from "./jev/mock.ts";
import { runLoop, type GenerateFn, type TurnEvent } from "./loop.ts";
import type { ChatProvider } from "./providers.ts";
import type { ConfirmFn, GateConfig, JevClient } from "./types.ts";

export type NodeId = "persist" | "http" | "ui" | "restart";
export type NodeState = "pending" | "running" | "checking" | "passed" | "failed" | "blocked" | "cancelled";

export type PlanNode = {
  id: NodeId;
  title: string;
  criterionId: string;
  mode: "add" | "search" | "ui" | "restart";
  state: NodeState;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  uncertain?: string;
};

export type DeliveryPlan = {
  taskId: string;
  fingerprint: string;
  targetDir: string;
  nodes: PlanNode[];
  readyForReview: boolean;
  openUrl?: string;
  storePath?: string;
  testedWorkspaceHash?: string;
  lastReconcile?: string;
};

const NODES: Array<Pick<PlanNode, "id" | "title" | "criterionId" | "mode">> = [
  { id: "persist", title: "JSON store", criterionId: "add", mode: "add" },
  { id: "http", title: "HTTP add and search", criterionId: "search", mode: "search" },
  { id: "ui", title: "One inventory page", criterionId: "open", mode: "ui" },
  { id: "restart", title: "Restart keeps the device", criterionId: "restart", mode: "restart" },
];

export function checkScriptPath() {
  return path.join(packageRoot(), "scripts", "check-device-inventory.mjs");
}

export function emptyPlan(task: TaskRecord): DeliveryPlan {
  return {
    taskId: task.agreement.id,
    fingerprint: task.fingerprint,
    targetDir: task.targetDir,
    readyForReview: false,
    nodes: NODES.map((node) => ({
      ...node,
      state: "pending",
      attempts: 0,
      maxAttempts: 3,
    })),
  };
}

export async function loadPlan(cwd: string, task: TaskRecord) {
  const stored = await readSlotJson<DeliveryPlan>(cwd, "plan.json", task.slot);
  if (!stored) return undefined;
  if (stored.taskId !== task.agreement.id || stored.fingerprint !== task.fingerprint) {
    return emptyPlan(task);
  }
  return { ...stored, targetDir: task.targetDir };
}

export async function loadOrCreatePlan(cwd: string, task: TaskRecord) {
  return (await loadPlan(cwd, task)) ?? emptyPlan(task);
}

export async function savePlan(cwd: string, task: TaskRecord, plan: DeliveryPlan) {
  await writeSlotJson(cwd, "plan.json", plan, task.slot);
}

export function formatPlan(plan: DeliveryPlan) {
  const lines = [
    "Delivery plan",
    ...plan.nodes.map((node) => {
      const budget = `attempts ${node.attempts}/${node.maxAttempts}`;
      const extra = [
        node.lastError ? `error ${node.lastError}` : "",
        node.uncertain ? `uncertain ${node.uncertain}` : "",
      ]
        .filter(Boolean)
        .join("  ");
      return `- ${node.id}  ${node.state}  ${budget}${extra ? `  ${extra}` : ""}`;
    }),
    `Ready for review  ${plan.readyForReview ? "yes" : "no"}`,
    plan.openUrl
      ? `Open  ${plan.openUrl}  store ${plan.storePath ?? "(none)"}  hash ${plan.testedWorkspaceHash ?? "(none)"}`
      : "Open  (not bound)",
  ];
  return lines.join("\n");
}

async function reconcile(plan: DeliveryPlan) {
  const notes: string[] = [];
  const listenFile = path.join(plan.targetDir, ".listen.json");
  const storeFile = path.join(plan.targetDir, "data", "devices.json");
  if (existsSync(listenFile)) {
    notes.push("listen file present after an interrupted turn; server may still be running");
  }
  if (existsSync(storeFile)) {
    notes.push("device store exists; a previous add may have executed");
  }
  const interrupted = plan.nodes.filter((node) => node.state === "running" || node.state === "checking");
  for (const node of interrupted) {
    node.state = "failed";
    node.uncertain = notes.join("; ") || "interrupted before a check result was stored";
  }
  if (notes.length) plan.lastReconcile = notes.join("; ");
  return plan;
}

function requiredCriteria(task: TaskRecord) {
  const ids = new Set(task.agreement.acceptance.map((item) => item.id));
  const missing = INVENTORY_ACCEPTANCE.map((item) => item.id).filter((id) => !ids.has(id));
  return missing;
}

export async function openTestedResult(cwd: string) {
  const task = await loadTask(cwd);
  if (!task) throw new Error("No task agreement.");
  const plan = await loadPlan(cwd, task);
  const identity = await captureIdentity(cwd, task.targetDir);
  if (!plan?.readyForReview || !plan.openUrl || !plan.testedWorkspaceHash) {
    throw new Error("No tested result is bound. Run /task build until ready for review.");
  }
  if (identity.workspaceHash !== plan.testedWorkspaceHash) {
    throw new Error(
      `Open refused: workspace hash ${identity.workspaceHash} does not match tested ${plan.testedWorkspaceHash}. Evidence is stale.`,
    );
  }
  for (const item of task.agreement.acceptance) {
    const check = task.checks.filter((row) => row.criterionId === item.id).at(-1);
    if (!check || !isVerifiedCheck(check, item, task)) {
      throw new Error(`Open refused: criterion '${item.id}' is not verified against the tested source.`);
    }
  }
  return [
    "Open the tested result (local check, not live packaged)",
    `App  ${path.join(task.targetDir, "server.mjs")}`,
    `Last check URL  ${plan.openUrl} (ephemeral port; start server.mjs to open a live page)`,
    `Store  ${plan.storePath ?? path.join(task.targetDir, "data", "devices.json")}`,
    `Workspace hash  ${plan.testedWorkspaceHash}`,
    "Appearance only until you look at the page. This is not owner acceptance.",
  ].join("\n");
}

function parseOpen(output: string, targetDir: string) {
  const url = output.match(/^OPEN_URL (.+)$/m)?.[1]?.trim();
  const store = output.match(/^STORE (.+)$/m)?.[1]?.trim();
  return {
    openUrl: url,
    storePath: store ?? path.join(targetDir, "data", "devices.json"),
  };
}

async function runNodeCheck(cwd: string, task: TaskRecord, node: PlanNode) {
  const script = checkScriptPath();
  return runCheck(cwd, {
    criterionId: node.criterionId,
    argv: [process.execPath, script, node.mode],
    workdir: task.targetDir,
    timeoutMs: 30_000,
  });
}

async function allVerified(cwd: string) {
  const fresh = await loadTask(cwd);
  if (!fresh) return false;
  return fresh.agreement.acceptance.every((item) => {
    const check = fresh.checks.filter((row) => row.criterionId === item.id).at(-1);
    return check ? isVerifiedCheck(check, item, fresh) : false;
  });
}

async function buildNode(input: {
  cwd: string;
  task: TaskRecord;
  node: PlanNode;
  sessionId: string;
  jev: JevClient;
  config: GateConfig;
  confirm: ConfirmFn;
  generate?: GenerateFn;
  provider?: ChatProvider;
  model?: string;
  abortSignal?: AbortSignal;
  onEvent?: (event: TurnEvent) => void;
}) {
  const system = [
    await formatTaskSystemPrompt(input.cwd),
    "You are implementing one bounded delivery node. Do not mark owner acceptance.",
    `Node ${input.node.id}: ${input.node.title}.`,
    `Work only under ${input.task.targetDir} (relative work/${input.task.agreement.id}/).`,
    "App contract: server.mjs listens on 127.0.0.1 port 0, writes .listen.json {pid,port,url}.",
    "POST /devices JSON {id,name} persists to data/devices.json. GET /devices?q= searches it. GET / is one HTML page titled Device inventory.",
  ].join("\n");
  return runLoop({
    prompt: `Implement node '${input.node.id}' (${input.node.title}) for the confirmed agreement. Stop after that node.`,
    cwd: input.cwd,
    jev: input.jev,
    config: input.config,
    confirm: input.confirm,
    sessionId: input.sessionId,
    generate: input.generate,
    system,
    provider: input.provider,
    model: input.model,
    abortSignal: input.abortSignal,
    onEvent: input.onEvent,
  });
}

export async function runDeliveryBuild(input: {
  cwd: string;
  sessionId: string;
  mockJev?: boolean;
  local?: boolean;
  generate?: GenerateFn;
  confirm: ConfirmFn;
  provider?: ChatProvider;
  model?: string;
  abortSignal?: AbortSignal;
  onEvent?: (event: TurnEvent) => void;
}) {
  const task = await loadTask(input.cwd);
  if (!task) throw new Error("No task agreement.");
  if (task.slot.kind !== "named" || task.agreement.id !== INVENTORY_TASK_ID) {
    throw new Error(
      `Delivery loop is the device-inventory proving ground. Active task is '${task.agreement.id}'. Use /task new ${INVENTORY_TASK_ID}.`,
    );
  }
  if (task.agreement.status !== "confirmed") {
    throw new Error(`Confirm '${task.agreement.id}' before /task build.`);
  }
  const missing = requiredCriteria(task);
  if (missing.length) {
    throw new Error(`Agreement is missing criteria: ${missing.join(", ")}. Criteria cannot be weakened to match the app.`);
  }
  if (input.local && !input.generate) {
    throw new Error("Local planner cannot implement this app. Use a chat model, or an injected builder in tests.");
  }
  const jev = input.mockJev ? mockJev() : liveJev();
  const config = loadConfig(input.cwd);
  let plan = await reconcile(await loadOrCreatePlan(input.cwd, task));
  await savePlan(input.cwd, task, plan);

  for (const node of plan.nodes) {
    if (input.abortSignal?.aborted) {
      node.state = "cancelled";
      plan.readyForReview = false;
      await savePlan(input.cwd, task, plan);
      throw new Error("cancelled");
    }
    if (node.state === "passed") continue;
    if (node.state === "blocked") {
      await recordMissing(input.cwd, {
        criterionId: node.criterionId,
        command: `${node.mode} check`,
        note: node.lastError ?? "blocked after repair budget",
      });
      break;
    }
    while (node.attempts < node.maxAttempts) {
      if (input.abortSignal?.aborted) {
        node.state = "cancelled";
        await savePlan(input.cwd, task, plan);
        throw new Error("cancelled");
      }
      node.attempts += 1;
      node.state = "running";
      await savePlan(input.cwd, task, plan);
      const receipt = await buildNode({
        cwd: input.cwd,
        task,
        node,
        sessionId: input.sessionId,
        jev,
        config,
        confirm: input.confirm,
        generate: input.generate,
        provider: input.provider,
        model: input.model,
        abortSignal: input.abortSignal,
        onEvent: input.onEvent,
      });
      if (receipt.outcome === "cancelled") {
        node.state = "cancelled";
        node.lastError = "builder cancelled";
        await savePlan(input.cwd, task, plan);
        throw new Error("cancelled");
      }
      node.state = "checking";
      await savePlan(input.cwd, task, plan);
      const check = await runNodeCheck(input.cwd, task, node);
      if (check.status === "passed" && check.executed) {
        node.state = "passed";
        node.lastError = undefined;
        if (node.id === "ui") {
          const bound = parseOpen(check.output, task.targetDir);
          plan.openUrl = bound.openUrl;
          plan.storePath = bound.storePath;
        }
        await savePlan(input.cwd, task, plan);
        break;
      }
      node.state = "failed";
      node.lastError = `${check.status} exit ${check.exitCode ?? "-"}`;
      await savePlan(input.cwd, task, plan);
      if (node.attempts >= node.maxAttempts) {
        node.state = "blocked";
        await savePlan(input.cwd, task, plan);
        await setDeliveryFlags(input.cwd, { implemented: false, readyForReview: false });
        const latest = await loadTask(input.cwd);
        return {
          output: [
            latest ? renderCard(latest) : "",
            formatPlan(plan),
            `Blocked on '${node.id}' after ${node.attempts} attempts. Not converted to pass.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          plan,
        };
      }
    }
  }

  const persistHttpUi = plan.nodes.filter((node) => node.id !== "restart");
  const implemented = persistHttpUi.every((node) => node.state === "passed");
  await setDeliveryFlags(input.cwd, { implemented, readyForReview: false });

  if (plan.nodes.some((node) => node.state !== "passed")) {
    const latest = await loadTask(input.cwd);
    return {
      output: [latest ? renderCard(latest) : "", formatPlan(plan)].filter(Boolean).join("\n\n"),
      plan,
    };
  }

  for (const node of plan.nodes) {
    const check = await runNodeCheck(input.cwd, task, node);
    if (check.status !== "passed" || !check.executed) {
      node.state = "failed";
      node.lastError = "final candidate check failed";
      plan.readyForReview = false;
      await savePlan(input.cwd, task, plan);
      await setDeliveryFlags(input.cwd, { implemented: false, readyForReview: false });
      const latest = await loadTask(input.cwd);
      return {
        output: [
          latest ? renderCard(latest) : "",
          formatPlan(plan),
          "Final candidate checks failed. Not ready for review.",
        ]
          .filter(Boolean)
          .join("\n\n"),
        plan,
      };
    }
    if (node.id === "ui") {
      const bound = parseOpen(check.output, task.targetDir);
      plan.openUrl = bound.openUrl;
      plan.storePath = bound.storePath;
    }
  }

  const verified = await loadTask(input.cwd);
  const identity = await captureIdentity(input.cwd, task.targetDir);
  const ready = Boolean(verified && (await allVerified(input.cwd)) && plan.openUrl);
  plan.readyForReview = ready;
  plan.testedWorkspaceHash = ready ? identity.workspaceHash : undefined;
  await savePlan(input.cwd, task, plan);
  await setDeliveryFlags(input.cwd, { implemented: true, readyForReview: ready });
  const cardTask = await loadTask(input.cwd);
  return {
    output: [
      cardTask ? renderCard(cardTask) : "",
      formatPlan(plan),
      ready
        ? "Ready for owner review. /task open binds this tested hash. Only /task accept records acceptance."
        : "Build finished without a verified open binding.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    plan,
  };
}
