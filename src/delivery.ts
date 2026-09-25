import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, writeFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_VERSION } from "./brand.ts";
import { packageRoot } from "./env.ts";
import { runOwnedArgv } from "./exec.ts";
import { harnessRoot } from "./session.ts";
import type { TaskPermission } from "./types.ts";

export type CriterionStatus = "passed" | "failed" | "blocked" | "not_run" | "reported";
export type CheckKind = "run" | "reported" | "file";

export type Criterion = {
  id: string;
  text: string;
};

export type Agreement = {
  id: string;
  objective: string;
  scope: string[];
  acceptance: Criterion[];
  exclusions: string[];
  references?: string[];
  status: "proposed" | "confirmed";
  confirmedAt?: string;
  confirmedBy?: "owner";
};

export type Revision = {
  at: string;
  reason: string;
  weakened: boolean;
  meaningChanged: boolean;
  before: { acceptance: { id: string; text: string }[]; exclusions: string[] };
  after: { acceptance: { id: string; text: string }[]; exclusions: string[] };
};

export type SourceIdentity = {
  version: string;
  git: string;
  harnessHash: string;
  workspaceHash: string;
  node: string;
  platform: string;
  at: string;
};

export type CheckRecord = {
  criterionId: string;
  criterionText: string;
  agreementHash: string;
  status: CriterionStatus;
  stale?: boolean;
  command: string;
  argv?: string[];
  exitCode?: number;
  output: string;
  kind: CheckKind;
  executed: boolean;
  workdir?: string;
  identity: SourceIdentity;
  at: string;
};

export type TaskRecord = {
  agreement: Agreement;
  fingerprint: string;
  targetDir: string;
  slot: TaskSlot;
  revisions: Revision[];
  checks: CheckRecord[];
  changed: string[];
  screenshots: { path: string; caption: string }[];
  implemented: boolean;
  readyForReview: boolean;
  ownerAccepted: boolean;
  ownerAcceptedAt?: string;
};

export type TaskMeta = {
  changed: string[];
  screenshots: { path: string; caption: string }[];
  implemented: boolean;
  readyForReview: boolean;
  ownerAccepted: boolean;
  ownerAcceptedAt?: string;
};

export const INVENTORY_TASK_ID = "device-inventory";

export const INVENTORY_ACCEPTANCE: Criterion[] = [
  { id: "add", text: "POST add returns success and the JSON store contains the device." },
  { id: "search", text: "Query returns that device." },
  { id: "restart", text: "After stop and start, search still returns the same device." },
  { id: "open", text: "A local URL and store path are bound to the tested workspace hash." },
];

export type TaskSlot = { kind: "legacy" } | { kind: "named"; id: string };

export type PendingConfirm = {
  id: string;
  fingerprint: string;
  slot: TaskSlot;
  sessionId: string;
  at: string;
};

export type PendingDraft = { id: string; sessionId: string; at: string };

const DISCLAIMERS = [
  "Screenshots do not prove functionality.",
  "Tests passing is not product acceptance.",
  "Jev scores are not OS isolation or spending limits.",
  "Shell-off and Jev do not sandbox generated Node.",
  "Reported notes are not verification.",
];

const SKIP_DIRS = new Set([".harness", ".git", "node_modules", "coverage", "dist", "data"]);
const SKIP_FILES = new Set([".listen.json"]);

export function taskDir(cwd: string) {
  return path.join(harnessRoot(cwd), "task");
}

export function safeTaskId(id: string) {
  const trimmed = id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(trimmed)) {
    throw new Error("Task id must be 1-80 letters, numbers, dots, underscores, or dashes.");
  }
  return trimmed;
}

function namedTaskDir(cwd: string, id: string) {
  return path.join(harnessRoot(cwd), "tasks", safeTaskId(id));
}

export function slotDir(cwd: string, slot: TaskSlot) {
  return slot.kind === "legacy" ? taskDir(cwd) : namedTaskDir(cwd, slot.id);
}

function taskFile(cwd: string, name: string, slot: TaskSlot = { kind: "legacy" }) {
  return path.join(slotDir(cwd, slot), name);
}

function activeRefFile(cwd: string) {
  return path.join(harnessRoot(cwd), "active-task.json");
}

function pendingConfirmFile(cwd: string) {
  return path.join(harnessRoot(cwd), "pending-confirm.json");
}

function pendingDraftFile(cwd: string) {
  return path.join(harnessRoot(cwd), "pending-draft.json");
}

export async function readActiveSlot(cwd: string): Promise<TaskSlot | undefined> {
  const stored = await readOptionalJson<TaskSlot>(activeRefFile(cwd));
  if (stored?.kind === "named" && stored.id) return { kind: "named", id: stored.id };
  if (stored?.kind === "legacy") return { kind: "legacy" };
  const legacy = await readAgreementState(cwd, { kind: "legacy" });
  if (legacy.kind !== "absent") return { kind: "legacy" };
  return undefined;
}

export async function writeActiveSlot(cwd: string, slot: TaskSlot) {
  await writeJson(activeRefFile(cwd), slot);
}

export async function readPendingConfirm(cwd: string, sessionId?: string): Promise<PendingConfirm | undefined> {
  const pending = await readOptionalJson<PendingConfirm>(pendingConfirmFile(cwd));
  if (!pending) return undefined;
  if (sessionId !== undefined && pending.sessionId !== sessionId) return undefined;
  return pending;
}

export async function writePendingConfirm(cwd: string, pending: PendingConfirm) {
  await writeJson(pendingConfirmFile(cwd), pending);
}

export async function clearPendingConfirm(cwd: string) {
  await unlinkQuiet(pendingConfirmFile(cwd));
}

export async function readPendingDraft(cwd: string, sessionId?: string): Promise<PendingDraft | undefined> {
  const draft = await readOptionalJson<PendingDraft>(pendingDraftFile(cwd));
  if (!draft) return undefined;
  if (sessionId !== undefined && draft.sessionId !== sessionId) return undefined;
  return draft;
}

export async function writePendingDraft(cwd: string, draft: PendingDraft) {
  await writeJson(pendingDraftFile(cwd), draft);
}

export async function clearPendingDraft(cwd: string) {
  await unlinkQuiet(pendingDraftFile(cwd));
}

export async function clearConversationalPending(cwd: string) {
  await clearPendingConfirm(cwd);
  await clearPendingDraft(cwd);
}

export function agreementFromOwnerText(id: string, text: string): Agreement {
  const objective = text.trim();
  if (!objective) throw new Error("Agreement text is empty.");
  return {
    id: safeTaskId(id),
    objective: objective.slice(0, 8000),
    scope: ["as stated in the objective"],
    acceptance:
      safeTaskId(id) === INVENTORY_TASK_ID
        ? INVENTORY_ACCEPTANCE
        : [
            {
              id: "a1",
              text: "Matches the stated requirements and acceptance examples in the objective.",
            },
          ],
    exclusions: ["Do not overwrite another task's records", "Do not mark owner acceptance"],
    status: "proposed",
  };
}

export function canonicalDir(dir: string) {
  return path.resolve(dir);
}

export function workDirForSlot(cwd: string, slot: TaskSlot) {
  return slot.kind === "named" ? canonicalDir(path.join(cwd, "work", slot.id)) : canonicalDir(cwd);
}

export async function ensureWorkDir(cwd: string, slot: TaskSlot) {
  const dir = workDirForSlot(cwd, slot);
  if (slot.kind === "named") await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeSlotJson(cwd: string, name: string, value: unknown, slot: TaskSlot) {
  await writeJson(taskFile(cwd, name, slot), value);
}

export async function readSlotJson<T>(cwd: string, name: string, slot: TaskSlot) {
  return readOptionalJson<T>(taskFile(cwd, name, slot));
}

async function referenceBodies(cwd: string, references: string[] | undefined) {
  const bodies: Record<string, string> = {};
  const root = canonicalDir(cwd);
  for (const ref of [...(references ?? [])].sort()) {
    const target = path.resolve(root, ref);
    const rel = path.relative(root, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      bodies[ref] = "outside";
      continue;
    }
    try {
      bodies[ref] = createHash("sha256")
        .update(await readFile(target))
        .digest("hex")
        .slice(0, 16);
    } catch {
      bodies[ref] = "missing";
    }
  }
  return bodies;
}

export async function agreementHash(
  agreement: Pick<Agreement, "id" | "objective" | "scope" | "acceptance" | "exclusions" | "references">,
  cwd: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: agreement.id,
        objective: agreement.objective,
        scope: agreement.scope,
        acceptance: agreement.acceptance.map((item) => ({ id: item.id, text: item.text })),
        exclusions: agreement.exclusions,
        references: [...(agreement.references ?? [])].sort(),
        referenceBodies: await referenceBodies(cwd, agreement.references),
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

async function gitHead(root: string) {
  try {
    const head = (await readFile(path.join(root, ".git", "HEAD"), "utf8")).trim();
    if (head.startsWith("ref: ")) {
      return (await readFile(path.join(root, ".git", head.slice(5).trim()), "utf8")).trim();
    }
    return head;
  } catch {
    return "unknown";
  }
}

async function hashPath(target: string, hash: ReturnType<typeof createHash>, root: string) {
  let info;
  try {
    info = await stat(target);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
      await hashPath(path.join(target, entry.name), hash, root);
    }
    return;
  }
  if (!info.isFile()) return;
  hash.update(path.relative(root, target));
  hash.update(await readFile(target));
}

export async function captureIdentity(taskCwd: string, targetDir = taskCwd): Promise<SourceIdentity> {
  const root = packageRoot();
  const harness = createHash("sha256");
  await hashPath(path.join(root, "src"), harness, root);
  await hashPath(path.join(root, "package.json"), harness, root);
  await hashPath(path.join(root, "package-lock.json"), harness, root);
  await hashPath(path.join(root, "gate.config.json"), harness, root);
  harness.update(APP_VERSION);
  const workspace = createHash("sha256");
  const workspaceRoot = path.resolve(targetDir);
  await hashPath(workspaceRoot, workspace, workspaceRoot);
  return {
    version: APP_VERSION,
    git: await gitHead(root),
    harnessHash: harness.digest("hex").slice(0, 16),
    workspaceHash: workspace.digest("hex").slice(0, 16),
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    at: new Date().toISOString(),
  };
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${randomUUID()}.json`);
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      await rename(tmp, file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
      await unlink(file);
      await rename(tmp, file);
    }
  } catch (error) {
    await unlinkQuiet(tmp);
    throw error;
  }
}

async function unlinkQuiet(file: string) {
  try {
    await unlink(file);
  } catch {
    // ignore
  }
}

async function readOptionalJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    return undefined;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseAgreement(raw: unknown): Agreement {
  if (!raw || typeof raw !== "object") throw new Error("agreement is not an object");
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) throw new Error("agreement.id is required");
  if (typeof row.objective !== "string" || !row.objective.trim()) {
    throw new Error("agreement.objective is required");
  }
  if (!isStringArray(row.scope)) throw new Error("agreement.scope must be a string list");
  if (!Array.isArray(row.acceptance) || row.acceptance.length < 1) {
    throw new Error("agreement.acceptance is required");
  }
  const acceptance: Criterion[] = row.acceptance.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`acceptance[${index}] is invalid`);
    const criterion = item as Record<string, unknown>;
    if (typeof criterion.id !== "string" || !criterion.id.trim()) {
      throw new Error(`acceptance[${index}].id is required`);
    }
    if (typeof criterion.text !== "string" || !criterion.text.trim()) {
      throw new Error(`acceptance[${index}].text is required`);
    }
    return { id: criterion.id, text: criterion.text };
  });
  if (!isStringArray(row.exclusions)) throw new Error("agreement.exclusions must be a string list");
  if (row.references !== undefined && !isStringArray(row.references)) {
    throw new Error("agreement.references must be a string list");
  }
  if (row.status !== "proposed" && row.status !== "confirmed") {
    throw new Error("agreement.status must be proposed or confirmed");
  }
  return {
    id: row.id,
    objective: row.objective,
    scope: row.scope,
    acceptance,
    exclusions: row.exclusions,
    references: row.references,
    status: row.status,
    confirmedAt: typeof row.confirmedAt === "string" ? row.confirmedAt : undefined,
    confirmedBy: row.confirmedBy === "owner" ? "owner" : undefined,
  };
}

export type AgreementState =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; agreement: Agreement };

export async function readAgreementState(cwd: string, slot: TaskSlot = { kind: "legacy" }): Promise<AgreementState> {
  const file = taskFile(cwd, "agreement.json", slot);
  try {
    await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", reason: "unreadable agreement" };
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { kind: "invalid", reason: "unreadable agreement" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "corrupt agreement JSON" };
  }
  try {
    return { kind: "ok", agreement: parseAgreement(raw) };
  } catch (error) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function checkStale(check: CheckRecord, task: { agreement: Agreement; fingerprint: string; targetDir: string }, identity: SourceIdentity) {
  if (check.agreementHash !== task.fingerprint) return true;
  const criterion = task.agreement.acceptance.find((item) => item.id === check.criterionId);
  if (!criterion || check.criterionText !== criterion.text) return true;
  if (check.kind === "run" && check.executed) {
    if (!check.workdir || canonicalDir(check.workdir) !== canonicalDir(task.targetDir)) return true;
  }
  if (check.identity.harnessHash !== identity.harnessHash) return true;
  if (check.identity.workspaceHash !== identity.workspaceHash) return true;
  return false;
}

export function isVerifiedCheck(check: CheckRecord, criterion: Criterion, task: Pick<TaskRecord, "agreement" | "fingerprint" | "targetDir">) {
  if (check.stale) return false;
  if (!check.executed) return false;
  if (check.kind !== "run") return false;
  if (check.status !== "passed") return false;
  if (check.exitCode !== 0) return false;
  if (check.agreementHash !== task.fingerprint) return false;
  if (check.criterionText !== criterion.text) return false;
  if (!check.workdir || canonicalDir(check.workdir) !== canonicalDir(task.targetDir)) return false;
  return true;
}

export async function loadTask(cwd: string, slot?: TaskSlot): Promise<TaskRecord | undefined> {
  const resolved = slot ?? (await readActiveSlot(cwd));
  if (!resolved) return undefined;
  const state = await readAgreementState(cwd, resolved);
  if (state.kind === "absent") return undefined;
  if (state.kind === "invalid") throw new Error(`Broken delivery agreement: ${state.reason}`);
  const revisions = (await readOptionalJson<Revision[]>(taskFile(cwd, "revisions.json", resolved))) ?? [];
  const checks = (await readOptionalJson<CheckRecord[]>(taskFile(cwd, "evidence.json", resolved))) ?? [];
  const meta =
    (await readOptionalJson<{
      changed?: string[];
      screenshots?: { path: string; caption: string }[];
      implemented?: boolean;
      readyForReview?: boolean;
      ownerAccepted?: boolean;
      ownerAcceptedAt?: string;
    }>(taskFile(cwd, "meta.json", resolved))) ?? {};
  const targetDir = workDirForSlot(cwd, resolved);
  const identity = await captureIdentity(cwd, targetDir);
  const fingerprint = await agreementHash(state.agreement, cwd);
  const task: TaskRecord = {
    agreement: state.agreement,
    fingerprint,
    targetDir,
    slot: resolved,
    revisions,
    checks,
    changed: meta.changed ?? [],
    screenshots: meta.screenshots ?? [],
    implemented: meta.implemented === true,
    readyForReview: meta.readyForReview === true,
    ownerAccepted: meta.ownerAccepted === true,
    ownerAcceptedAt: meta.ownerAcceptedAt,
  };
  task.checks = await Promise.all(
    checks.map(async (check) => ({ ...check, stale: await checkStale(check, task, identity) })),
  );
  return task;
}

export async function taskPermission(cwd: string): Promise<TaskPermission> {
  const slot = await readActiveSlot(cwd);
  if (!slot) return "untracked";
  const state = await readAgreementState(cwd, slot);
  if (state.kind === "absent") return "untracked";
  if (state.kind === "invalid") return "invalid";
  return state.agreement.status;
}

export function isTerminalAgreementBlock(reason: string | undefined) {
  if (!reason) return false;
  return /unconfirmed delivery agreement|broken delivery agreement/.test(reason);
}

export async function deliveryMutationBlock(cwd: string): Promise<string | undefined> {
  const slot = await readActiveSlot(cwd);
  if (!slot) return undefined;
  const state = await readAgreementState(cwd, slot);
  if (state.kind === "absent") return undefined;
  if (state.kind === "invalid") {
    return `broken delivery agreement (${state.reason}); repair before mutations. Ordinary untracked chat has no .harness/task agreement.`;
  }
  const fingerprint = await agreementHash(state.agreement, cwd);
  if (state.agreement.status === "confirmed") return undefined;
  return `unconfirmed delivery agreement '${state.agreement.id}' hash ${fingerprint}; /task confirm ${state.agreement.id} ${fingerprint} after reviewing that exact version. Ordinary untracked chat has no .harness/task agreement. /task new <id> proposes a different task without overwriting this one.`;
}

export async function writeAgreement(cwd: string, agreement: Agreement) {
  if (agreement.status === "confirmed") {
    throw new Error("Use confirmAgreement. Do not write a confirmed agreement directly.");
  }
  const slot: TaskSlot = { kind: "legacy" };
  const proposed = { ...agreement, status: "proposed" as const };
  delete proposed.confirmedAt;
  delete proposed.confirmedBy;
  await writeJson(taskFile(cwd, "agreement.json", slot), proposed);
  await writeJson(taskFile(cwd, "revisions.json", slot), []);
  await writeJson(taskFile(cwd, "evidence.json", slot), []);
  await writeJson(taskFile(cwd, "meta.json", slot), {
    changed: [],
    screenshots: [],
    implemented: false,
    readyForReview: false,
    ownerAccepted: false,
  });
  await writeActiveSlot(cwd, slot);
  await clearPendingConfirm(cwd);
  return proposed;
}

export async function findSlotById(cwd: string, id: string): Promise<TaskSlot | undefined> {
  const wanted = safeTaskId(id);
  const namedState = await readAgreementState(cwd, { kind: "named", id: wanted });
  if (namedState.kind !== "absent") return { kind: "named", id: wanted };
  const legacy = await readAgreementState(cwd, { kind: "legacy" });
  if (legacy.kind === "ok" && legacy.agreement.id === wanted) return { kind: "legacy" };
  return undefined;
}

export async function proposeNewTask(cwd: string, agreement: Agreement, sessionId: string) {
  if (agreement.status === "confirmed") {
    throw new Error("Use confirmAgreement. Do not write a confirmed agreement directly.");
  }
  const id = safeTaskId(agreement.id);
  const existing = await findSlotById(cwd, id);
  if (existing) {
    throw new Error(`Task '${id}' already exists. It was not overwritten.`);
  }
  const slot: TaskSlot = { kind: "named", id };
  const proposed = { ...agreement, id, status: "proposed" as const };
  delete proposed.confirmedAt;
  delete proposed.confirmedBy;
  await writeJson(taskFile(cwd, "agreement.json", slot), proposed);
  await writeJson(taskFile(cwd, "revisions.json", slot), []);
  await writeJson(taskFile(cwd, "evidence.json", slot), []);
  await writeJson(taskFile(cwd, "meta.json", slot), {
    changed: [],
    screenshots: [],
    implemented: false,
    readyForReview: false,
    ownerAccepted: false,
  });
  await ensureWorkDir(cwd, slot);
  const fingerprint = await agreementHash(proposed, cwd);
  const pending: PendingConfirm = {
    id,
    fingerprint,
    slot,
    sessionId,
    at: new Date().toISOString(),
  };
  await writePendingConfirm(cwd, pending);
  await clearPendingDraft(cwd);
  return { agreement: proposed, fingerprint, slot };
}

export async function confirmAgreement(
  cwd: string,
  actor: "owner",
  bound?: { id?: string; fingerprint?: string },
) {
  if (actor !== "owner") throw new Error("Only the owner can confirm the agreement.");
  const pending = await readPendingConfirm(cwd);
  let slot: TaskSlot | undefined;
  if (bound?.id) {
    slot = await findSlotById(cwd, bound.id);
    if (!slot) throw new Error(`No task '${bound.id}'.`);
  } else if (pending) {
    slot = pending.slot;
  } else {
    slot = await readActiveSlot(cwd);
  }
  if (!slot) throw new Error("No task agreement.");
  const task = await loadTask(cwd, slot);
  if (!task) throw new Error("No task agreement.");
  if (bound?.id && task.agreement.id !== safeTaskId(bound.id)) {
    throw new Error(`Refusing to confirm '${task.agreement.id}' as '${bound.id}'.`);
  }
  if (pending && !bound?.id && (pending.id !== task.agreement.id || pending.fingerprint !== task.fingerprint)) {
    throw new Error(
      `Displayed agreement ${pending.id} hash ${pending.fingerprint} no longer matches ${task.agreement.id} hash ${task.fingerprint}. Review /task.`,
    );
  }
  const expected =
    bound?.fingerprint ??
    (pending && (!bound?.id || pending.id === bound.id) ? pending.fingerprint : undefined);
  if (expected && expected !== task.fingerprint) {
    throw new Error(
      `Refusing to confirm '${task.agreement.id}'. Displayed hash ${expected}, current hash ${task.fingerprint}.`,
    );
  }
  const confirmed: Agreement = {
    ...task.agreement,
    status: "confirmed",
    confirmedAt: new Date().toISOString(),
    confirmedBy: "owner",
  };
  await writeJson(taskFile(cwd, "agreement.json", slot), confirmed);
  await writeActiveSlot(cwd, slot);
  await ensureWorkDir(cwd, slot);
  await clearPendingConfirm(cwd);
  return confirmed;
}

export function assertReadyToImplement(task: TaskRecord) {
  if (task.agreement.status !== "confirmed") {
    throw new Error("Owner has not confirmed the agreement.");
  }
}

export async function reviseAgreement(
  cwd: string,
  next: Pick<Agreement, "objective" | "scope" | "acceptance" | "exclusions" | "references">,
  input: { reason: string; allowWeaken?: boolean },
) {
  if (!input.reason.trim()) throw new Error("Revisions need a reason.");
  const task = await loadTask(cwd);
  if (!task) throw new Error("No task agreement.");
  const beforeAccept = task.agreement.acceptance.map((item) => ({ id: item.id, text: item.text }));
  const afterAccept = next.acceptance.map((item) => ({ id: item.id, text: item.text }));
  const beforeIds = beforeAccept.map((item) => item.id);
  const afterIds = afterAccept.map((item) => item.id);
  const removed = beforeIds.filter((id) => !afterIds.includes(id));
  const droppedExclusion = task.agreement.exclusions.filter((item) => !next.exclusions.includes(item));
  const textChanged = beforeAccept.some((item) => {
    const nextItem = afterAccept.find((row) => row.id === item.id);
    return nextItem !== undefined && nextItem.text !== item.text;
  });
  const nextRefs = next.references ?? task.agreement.references;
  const refsChanged =
    JSON.stringify([...(task.agreement.references ?? [])].sort()) !==
    JSON.stringify([...(nextRefs ?? [])].sort());
  const meaningChanged = textChanged || removed.length > 0 || refsChanged;
  const weakened = removed.length > 0 || droppedExclusion.length > 0 || textChanged;
  if (weakened && !input.allowWeaken) {
    throw new Error("Refusing silent weaken. Pass allowWeaken after the owner agrees.");
  }
  const revision: Revision = {
    at: new Date().toISOString(),
    reason: input.reason,
    weakened,
    meaningChanged,
    before: { acceptance: beforeAccept, exclusions: task.agreement.exclusions },
    after: { acceptance: afterAccept, exclusions: next.exclusions },
  };
  const agreement: Agreement = {
    ...task.agreement,
    ...next,
    references: nextRefs,
    status: "proposed",
    confirmedAt: undefined,
    confirmedBy: undefined,
  };
  await writeJson(taskFile(cwd, "agreement.json", task.slot), agreement);
  await writeJson(taskFile(cwd, "revisions.json", task.slot), [...task.revisions, revision]);
  await writeJson(taskFile(cwd, "meta.json", task.slot), {
    changed: task.changed,
    screenshots: task.screenshots,
    implemented: false,
    readyForReview: false,
    ownerAccepted: false,
  });
  return revision;
}

async function appendCheck(cwd: string, record: CheckRecord) {
  const task = await loadTask(cwd);
  const slot = task?.slot ?? { kind: "legacy" as const };
  const previous = (await readOptionalJson<CheckRecord[]>(taskFile(cwd, "evidence.json", slot))) ?? [];
  previous.push(record);
  await writeJson(taskFile(cwd, "evidence.json", slot), previous);
  return record;
}

async function criterionFor(cwd: string, criterionId: string) {
  const task = await loadTask(cwd);
  if (!task) throw new Error("No task agreement.");
  const criterion = task.agreement.acceptance.find((item) => item.id === criterionId);
  if (!criterion) throw new Error(`Unknown criterion ${criterionId}`);
  return { task, criterion, hash: task.fingerprint, identity: await captureIdentity(cwd, task.targetDir) };
}

function runArgv(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
) {
  return runOwnedArgv(argv, cwd, { timeoutMs, abortSignal });
}

export async function runCheck(
  cwd: string,
  input: { criterionId: string; argv: string[]; workdir?: string; timeoutMs?: number; abortSignal?: AbortSignal },
) {
  const { task, criterion, hash, identity } = await criterionFor(cwd, input.criterionId);
  const workdir = canonicalDir(input.workdir ?? task.targetDir);
  if (workdir !== task.targetDir) {
    throw new Error(
      `Check workdir must be the agreed task directory (${task.targetDir}); got ${workdir}. A zero exit from another project is not this project's evidence.`,
    );
  }
  const result = await runArgv(input.argv, workdir, input.timeoutMs ?? 120_000, input.abortSignal);
  let status: CriterionStatus = "failed";
  if (!result.executed) status = "blocked";
  else if (result.exitCode === 0) status = "passed";
  return appendCheck(cwd, {
    criterionId: input.criterionId,
    criterionText: criterion.text,
    agreementHash: hash,
    status,
    command: input.argv.join(" "),
    argv: input.argv,
    exitCode: result.exitCode,
    output: result.output,
    kind: "run",
    executed: result.executed,
    workdir,
    identity,
    at: new Date().toISOString(),
  });
}

export async function reportCheck(
  cwd: string,
  input: { criterionId: string; note: string; command?: string },
) {
  const { criterion, hash, identity } = await criterionFor(cwd, input.criterionId);
  return appendCheck(cwd, {
    criterionId: input.criterionId,
    criterionText: criterion.text,
    agreementHash: hash,
    status: "reported",
    command: input.command ?? "reported",
    output: input.note.slice(0, 8000),
    kind: "reported",
    executed: false,
    identity,
    at: new Date().toISOString(),
  });
}

export async function recordMissing(
  cwd: string,
  input: { criterionId: string; command: string; note: string },
) {
  const { criterion, hash, identity } = await criterionFor(cwd, input.criterionId);
  return appendCheck(cwd, {
    criterionId: input.criterionId,
    criterionText: criterion.text,
    agreementHash: hash,
    status: "not_run",
    command: input.command,
    output: input.note.slice(0, 8000),
    kind: "file",
    executed: false,
    identity,
    at: new Date().toISOString(),
  });
}

export async function recordCheck(
  _cwd: string,
  _input: { criterionId: string; status: CriterionStatus; command: string; output: string; kind: string; exitCode?: number },
): Promise<CheckRecord> {
  throw new Error("Use runCheck for verification. Descriptions cannot set passed.");
}

export async function noteChanged(cwd: string, files: string[]) {
  const task = await loadTask(cwd);
  if (!task) throw new Error("No task agreement.");
  const changed = [...new Set([...task.changed, ...files])];
  await writeJson(taskFile(cwd, "meta.json", task.slot), {
    changed,
    screenshots: task.screenshots,
    implemented: task.implemented,
    readyForReview: task.readyForReview,
    ownerAccepted: task.ownerAccepted,
    ownerAcceptedAt: task.ownerAcceptedAt,
  });
}

export async function addScreenshot(cwd: string, shot: { path: string; caption: string }) {
  const task = await loadTask(cwd);
  if (!task) throw new Error("No task agreement.");
  await writeJson(taskFile(cwd, "meta.json", task.slot), {
    changed: task.changed,
    screenshots: [...task.screenshots, shot],
    implemented: task.implemented,
    readyForReview: task.readyForReview,
    ownerAccepted: task.ownerAccepted,
    ownerAcceptedAt: task.ownerAcceptedAt,
  });
}

export async function markImplemented(cwd: string) {
  const task = await loadTask(cwd);
  if (!task) throw new Error("No task agreement.");
  assertReadyToImplement(task);
  await writeJson(taskFile(cwd, "meta.json", task.slot), {
    changed: task.changed,
    screenshots: task.screenshots,
    implemented: true,
    readyForReview: false,
    ownerAccepted: false,
    ownerAcceptedAt: undefined,
  });
}

export async function acceptTask(cwd: string, actor: "owner") {
  if (actor !== "owner") throw new Error("Only the owner can record acceptance.");
  const task = await loadTask(cwd);
  if (!task) throw new Error("No task agreement.");
  if (task.agreement.status !== "confirmed") {
    throw new Error("Confirm the agreement before accepting delivery.");
  }
  await writeJson(taskFile(cwd, "meta.json", task.slot), {
    changed: task.changed,
    screenshots: task.screenshots,
    implemented: task.implemented,
    readyForReview: task.readyForReview,
    ownerAccepted: true,
    ownerAcceptedAt: new Date().toISOString(),
  });
}

export async function setDeliveryFlags(
  cwd: string,
  flags: { implemented?: boolean; readyForReview?: boolean; changed?: string[] },
) {
  const task = await loadTask(cwd);
  if (!task) throw new Error("No task agreement.");
  await writeJson(taskFile(cwd, "meta.json", task.slot), {
    changed: flags.changed ?? task.changed,
    screenshots: task.screenshots,
    implemented: flags.implemented ?? task.implemented,
    readyForReview: flags.readyForReview ?? task.readyForReview,
    ownerAccepted: task.ownerAccepted,
    ownerAcceptedAt: task.ownerAcceptedAt,
  });
}

function latestChecks(task: TaskRecord) {
  const map = new Map<string, CheckRecord>();
  for (const check of task.checks) map.set(check.criterionId, check);
  return map;
}

export function renderCard(task: TaskRecord) {
  const latest = latestChecks(task);
  const requested = task.agreement.acceptance.map((item) => `- ${item.id}: ${item.text}`);
  const verified: string[] = [];
  const notVerified: string[] = [];
  for (const item of task.agreement.acceptance) {
    const check = latest.get(item.id);
    if (!check) {
      notVerified.push(`- ${item.id}: not run`);
      continue;
    }
    const result = `${check.status}${check.stale ? " (stale)" : ""}  ${check.command}  exit ${check.exitCode ?? "-"}`;
    if (isVerifiedCheck(check, item, task)) verified.push(`- ${item.id}: ${result}`);
    else notVerified.push(`- ${item.id}: ${result}`);
  }
  const identity = task.checks.at(-1)?.identity;
  const lines = [
    "Aegis delivery card",
    "",
    `Agreement  ${task.agreement.id}  ${task.agreement.status}  hash ${task.fingerprint}`,
    `Target  ${task.targetDir}`,
    `Approved reference  ${(task.agreement.references ?? []).join(", ") || "(none)"}  ${task.agreement.status === "confirmed" ? task.agreement.confirmedAt : "(not confirmed)"}`,
    "",
    "Requested",
    `Objective: ${task.agreement.objective}`,
    ...requested,
    "",
    "Changed",
    ...(task.changed.length ? task.changed.map((file) => `- ${file}`) : ["- (none recorded)"]),
    "",
    "Verified",
    ...(verified.length ? verified : ["- (none)"]),
    "",
    "Not verified",
    ...(notVerified.length ? notVerified : ["- (none)"]),
    "",
    "Evidence",
    ...task.agreement.acceptance.map((item) => {
      const check = latest.get(item.id);
      if (!check) return `- ${item.id}: missing check`;
      const output = check.output.trim().split(/\r?\n/).slice(0, 6).join(" / ");
      return `- ${item.id}: ${check.status}${check.executed ? " ran" : " not-executed"} · ${check.command} · ${output || "(no output)"}`;
    }),
    "",
    "Screenshots (appearance only)",
    ...(task.screenshots.length
      ? task.screenshots.map((shot) => `- ${shot.path}  ${shot.caption}`)
      : ["- (none)"]),
    "",
    "Flags (kept separate)",
    `implemented     ${task.implemented ? "yes" : "no"}`,
    `ready for review  ${task.readyForReview && verified.length === task.agreement.acceptance.length ? "yes" : "no"}`,
    `checks passed   ${verified.length}/${task.agreement.acceptance.length}`,
    `owner accepted  ${task.ownerAccepted ? `yes ${task.ownerAcceptedAt}` : "no"}`,
    "",
    identity
      ? `Tested  v${identity.version}  git ${identity.git.slice(0, 12)}  harness ${identity.harnessHash}  workspace ${identity.workspaceHash}  ${identity.platform}  node ${identity.node}`
      : "Tested  (no check recorded)",
    "",
    ...DISCLAIMERS,
  ];
  if (task.revisions.length) {
    lines.push("", "Revisions");
    for (const rev of task.revisions) {
      const mark = rev.weakened ? "weaken" : rev.meaningChanged ? "meaning" : "revise";
      lines.push(`- ${rev.at}  ${mark}  ${rev.reason}`);
    }
  }
  return lines.join("\n");
}

export function formatAgreementPrompt(task: TaskRecord) {
  return [
    `Task ${task.agreement.id}  ${task.agreement.status}  hash ${task.fingerprint}`,
    "Objective:",
    task.agreement.objective,
    "Scope:",
    ...task.agreement.scope.map((item) => `- ${item}`),
    "Acceptance:",
    ...task.agreement.acceptance.map((item) => `- ${item.id}: ${item.text}`),
    "Exclusions:",
    ...task.agreement.exclusions.map((item) => `- ${item}`),
  ].join("\n");
}

export async function formatTaskSystemPrompt(cwd: string) {
  const status = await formatTaskStatus(cwd);
  const task = await loadTask(cwd).catch(() => undefined);
  if (!task) return status;
  return [
    status,
    "Full active agreement (authoritative; do not invent or truncate):",
    formatAgreementPrompt(task),
  ].join("\n\n");
}

export async function formatTaskStatus(cwd: string, sessionId?: string) {
  const activeSlot = await readActiveSlot(cwd);
  const pending = await readPendingConfirm(cwd, sessionId);
  const draft = await readPendingDraft(cwd, sessionId);
  const lines: string[] = [];
  if (!activeSlot) {
    lines.push("Active task  (none)  untracked chat");
  } else {
    const state = await readAgreementState(cwd, activeSlot);
    if (state.kind === "ok") {
      const fingerprint = await agreementHash(state.agreement, cwd);
      lines.push(
        `Active task  ${state.agreement.id}  ${state.agreement.status}  hash ${fingerprint}`,
        `Objective  ${state.agreement.objective.split(/\r?\n/)[0]!.slice(0, 160)}`,
      );
    } else if (state.kind === "invalid") {
      lines.push(`Active task  (unreadable)  ${state.reason}`);
    } else {
      lines.push("Active task  (none)  untracked chat");
    }
  }
  if (pending) {
    lines.push(
      `Pending confirm  ${pending.id}  hash ${pending.fingerprint}`,
      `Reply yes now to confirm that exact version, or /task confirm ${pending.id} ${pending.fingerprint}. An intervening prompt, /new, /clear, or restart cancels yes.`,
    );
  } else {
    lines.push("Pending confirm  (none)");
    const diskPending = sessionId ? await readOptionalJson<PendingConfirm>(pendingConfirmFile(cwd)) : undefined;
    if (diskPending && sessionId && diskPending.sessionId !== sessionId) {
      lines.push(
        `A proposal '${diskPending.id}' exists from another session. Plain yes will not confirm it. Re-review and /task confirm ${diskPending.id} ${diskPending.fingerprint}.`,
      );
    } else if (activeSlot) {
      const state = await readAgreementState(cwd, activeSlot);
      if (state.kind === "ok" && state.agreement.status === "proposed") {
        const fingerprint = await agreementHash(state.agreement, cwd);
        lines.push(
          `Plain yes will not confirm this. Use /task confirm ${state.agreement.id} ${fingerprint} or /task new <id> for a different task.`,
        );
      }
    }
  }
  if (draft) {
    lines.push(`Drafting  ${draft.id}  next message becomes this agreement. Active task stays untouched.`);
  }
  lines.push("Existing tasks are not overwritten by /task new.");
  return lines.join("\n");
}

export async function renderProposalReview(cwd: string, slot: TaskSlot) {
  const proposed = await loadTask(cwd, slot);
  if (!proposed) throw new Error("No proposed task to review.");
  const activeSlot = await readActiveSlot(cwd);
  const sameActive = activeSlot && JSON.stringify(activeSlot) === JSON.stringify(proposed.slot);
  const lines = [
    "Proposed agreement for review (not confirmed)",
    formatAgreementPrompt(proposed),
    "",
    renderCard(proposed),
  ];
  if (!sameActive && activeSlot) {
    const active = await loadTask(cwd, activeSlot).catch(() => undefined);
    if (active) {
      lines.push(
        "",
        "Preserved active task (unchanged — this is not what yes confirms)",
        `${active.agreement.id}  ${active.agreement.status}  hash ${active.fingerprint}`,
        `Objective  ${active.agreement.objective.split(/\r?\n/)[0]!.slice(0, 160)}`,
      );
    }
  }
  lines.push(
    "",
    `Reply yes now to confirm '${proposed.agreement.id}' hash ${proposed.fingerprint}, or /task confirm ${proposed.agreement.id} ${proposed.fingerprint}.`,
  );
  return lines.join("\n");
}

export async function renderTaskCard(cwd: string, sessionId?: string) {
  const status = await formatTaskStatus(cwd, sessionId);
  const slot = await readActiveSlot(cwd);
  if (!slot) {
    return `${status}\n\nNo task agreement. Ordinary untracked chat. Files live under .harness/task/ and .harness/tasks/<id>/`;
  }
  const state = await readAgreementState(cwd, slot);
  if (state.kind === "invalid") {
    return `${status}\n\nBroken delivery agreement (${state.reason}). Repair agreement.json before mutations or checks.`;
  }
  const task = await loadTask(cwd, slot);
  if (!task) {
    return `${status}\n\nNo task agreement. Ordinary untracked chat. Files live under .harness/task/`;
  }
  const card = `${status}\n\n${renderCard(task)}`;
  await writeFile(taskFile(cwd, "card.md", slot), `${card}\n`, "utf8");
  return card;
}
