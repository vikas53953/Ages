import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
  acceptTask,
  assertReadyToImplement,
  captureIdentity,
  confirmAgreement,
  isVerifiedCheck,
  loadTask,
  markImplemented,
  recordCheck,
  recordMissing,
  renderCard,
  reportCheck,
  reviseAgreement,
  runCheck,
  writeAgreement,
  type Agreement,
} from "../src/plugins/delivery/delivery.ts";
import { createTools } from "../src/loop.ts";
import { mockJev } from "../src/plugins/jev/mock.ts";
import { handleLine, startState } from "../src/runtime.ts";
import { loadPlugins } from "../src/plugins/index.ts";
import { toolGuards } from "../src/plugin-api.ts";

const shipped = () => loadPlugins(["jev", "delivery", "receipts"], { mockJev: true }).plugins;


const sample = (id = "demo"): Agreement => ({
  id,
  objective: "Ship one bounded lock fix with inspectable evidence.",
  scope: ["cancel", "cwd write", "delivery card"],
  acceptance: [
    { id: "c1", text: "Abort stops the write." },
    { id: "c2", text: "Card lists Requested Changed Verified Not verified." },
  ],
  exclusions: ["agent fleet", "model catalog expansion"],
  references: ["docs/status.md"],
  status: "proposed",
});

function section(card: string, name: "Verified" | "Not verified") {
  const blocks = card.split(/\n(?=Verified\n|Not verified\n)/);
  return blocks.find((block) => block.startsWith(`${name}\n`)) ?? "";
}

const localOpts = { toolCallId: "t1", messages: [], context: {} } as never;

describe("delivery records", () => {
  it("requires owner confirm before implementation and owner accept separately", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-task-"));
    await writeAgreement(cwd, sample());
    const draft = await loadTask(cwd);
    expect(draft?.agreement.status).toBe("proposed");
    expect(() => assertReadyToImplement(draft!)).toThrow(/not confirmed/);
    await expect(markImplemented(cwd)).rejects.toThrow(/not confirmed/);
    await expect(acceptTask(cwd, "owner")).rejects.toThrow(/Confirm the agreement/);
    await confirmAgreement(cwd, "owner");
    await markImplemented(cwd);
    const ready = await loadTask(cwd);
    expect(ready?.implemented).toBe(true);
    expect(ready?.ownerAccepted).toBe(false);
    await acceptTask(cwd, "owner");
    const accepted = await loadTask(cwd);
    expect(accepted?.ownerAccepted).toBe(true);
  });

  it("refuses silent weaken and keeps the revision list", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-task-rev-"));
    await writeAgreement(cwd, sample());
    await expect(
      reviseAgreement(
        cwd,
        {
          objective: "smaller",
          scope: ["cancel"],
          acceptance: [{ id: "c1", text: "Abort stops the write." }],
          exclusions: ["agent fleet"],
        },
        { reason: "drop c2" },
      ),
    ).rejects.toThrow(/silent weaken/);
    const revision = await reviseAgreement(
      cwd,
      {
        objective: "smaller",
        scope: ["cancel"],
        acceptance: [{ id: "c1", text: "Abort stops the write." }],
        exclusions: ["agent fleet"],
      },
      { reason: "owner dropped c2", allowWeaken: true },
    );
    expect(revision.weakened).toBe(true);
    const task = await loadTask(cwd);
    expect(task?.agreement.status).toBe("proposed");
    expect(task?.revisions).toHaveLength(1);
    expect(renderCard(task!)).toContain("weaken");
  });

  it("does not treat a handwritten passed check as verified", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-task-fake-"));
    await writeAgreement(cwd, sample());
    await expect(
      recordCheck(cwd, {
        criterionId: "c1",
        status: "passed",
        command: "never executed",
        output: "Model says done",
        kind: "test",
        exitCode: 1,
      }),
    ).rejects.toThrow(/cannot set passed/);
    const reported = await reportCheck(cwd, {
      criterionId: "c1",
      note: "Model says done",
      command: "never executed",
    });
    expect(reported.status).toBe("reported");
    expect(reported.executed).toBe(false);
    const card = renderCard((await loadTask(cwd))!);
    expect(section(card, "Verified")).not.toContain("c1: passed");
    expect(card).toContain("never executed");
  });

  it("verifies only from a spawned process result", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-task-run-"));
    await writeAgreement(cwd, sample());
    const passed = await runCheck(cwd, {
      criterionId: "c1",
      argv: [process.execPath, "-e", "process.stdout.write('ran-ok'); process.exit(0)"],
    });
    expect(passed.executed).toBe(true);
    expect(passed.exitCode).toBe(0);
    expect(passed.status).toBe("passed");
    expect(passed.output).toContain("ran-ok");
    const failed = await runCheck(cwd, {
      criterionId: "c1",
      argv: [process.execPath, "-e", "process.stdout.write('ran-bad'); process.exit(1)"],
    });
    expect(failed.executed).toBe(true);
    expect(failed.status).toBe("failed");
    const raw = JSON.parse(await readFile(path.join(cwd, ".harness", "task", "evidence.json"), "utf8")) as {
      status: string;
      executed: boolean;
    }[];
    expect(raw.map((row) => row.status)).toEqual(["passed", "failed"]);
    const card = renderCard((await loadTask(cwd))!);
    expect(section(card, "Not verified")).toContain("c1: failed");
  });

  it("invalidates evidence when criterion text changes and keeps history", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-task-mean-"));
    await writeAgreement(cwd, sample());
    const recorded = await runCheck(cwd, {
      criterionId: "c1",
      argv: [process.execPath, "-e", "process.stdout.write('ok'); process.exit(0)"],
    });
    expect(recorded.status).toBe("passed");
    expect(recorded.executed).toBe(true);
    const beforeTask = await loadTask(cwd);
    const last = beforeTask!.checks.at(-1);
    expect(last?.stale).toBe(false);
    expect(
      isVerifiedCheck(last!, beforeTask!.agreement.acceptance[0]!, beforeTask!),
      JSON.stringify(last, null, 2),
    ).toBe(true);
    const before = renderCard(beforeTask!);
    expect(section(before, "Verified")).toContain("c1: passed");
    await expect(
      reviseAgreement(
        cwd,
        {
          objective: sample().objective,
          scope: sample().scope,
          acceptance: [
            { id: "c1", text: "A completely different requirement." },
            { id: "c2", text: "Card lists Requested Changed Verified Not verified." },
          ],
          exclusions: sample().exclusions,
        },
        { reason: "rewrote c1" },
      ),
    ).rejects.toThrow(/silent weaken/);
    const revision = await reviseAgreement(
      cwd,
      {
        objective: sample().objective,
        scope: sample().scope,
        acceptance: [
          { id: "c1", text: "A completely different requirement." },
          { id: "c2", text: "Card lists Requested Changed Verified Not verified." },
        ],
        exclusions: sample().exclusions,
      },
      { reason: "rewrote c1", allowWeaken: true },
    );
    expect(revision.meaningChanged).toBe(true);
    const task = await loadTask(cwd);
    const after = task!.checks.filter((item) => item.criterionId === "c1").at(-1);
    expect(after?.stale).toBe(true);
    expect(after?.status).toBe("passed");
    const card = renderCard(task!);
    expect(section(card, "Verified")).not.toContain("c1: passed");
    expect(section(card, "Not verified")).toContain("c1: passed (stale)");
  });

  it("hashes the task workspace separately from the harness", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-task-id-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "application.ts"), "export const n = 1;\n", "utf8");
    const first = await captureIdentity(cwd);
    await writeFile(path.join(cwd, "src", "application.ts"), "export const n = 2;\n", "utf8");
    const second = await captureIdentity(cwd);
    expect(second.workspaceHash).not.toBe(first.workspaceHash);
    expect(second.harnessHash).toBe(first.harnessHash);
  });

  it("blocks mutations on a proposed agreement and allows untracked chat", async () => {
    const tracked = await mkdtemp(path.join(os.tmpdir(), "aegis-task-mut-"));
    const untracked = await mkdtemp(path.join(os.tmpdir(), "aegis-chat-"));
    await writeAgreement(tracked, sample());
    const toolsTracked = createTools({
      cwd: tracked,
      guards: toolGuards(shipped()),
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => true,
      onTool: () => undefined,
    });
    const blocked = String(
      await toolsTracked.write.execute!({ path: "a.txt", contents: "x" }, localOpts),
    );
    expect(blocked).toContain("unconfirmed delivery agreement");
    await expect(readFile(path.join(tracked, "a.txt"), "utf8")).rejects.toThrow();
    const toolsFree = createTools({
      cwd: untracked,
      guards: toolGuards(shipped()),
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => true,
      onTool: () => undefined,
    });
    const wrote = String(
      await toolsFree.write.execute!({ path: "a.txt", contents: "hello" }, localOpts),
    );
    expect(wrote).toContain("wrote");
    expect(await readFile(path.join(untracked, "a.txt"), "utf8")).toBe("hello");
    await confirmAgreement(tracked, "owner");
    const toolsOk = createTools({
      cwd: tracked,
      guards: toolGuards(shipped()),
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => true,
      onTool: () => undefined,
    });
    const after = String(
      await toolsOk.write.execute!({ path: "b.txt", contents: "ok" }, localOpts),
    );
    expect(after).toContain("wrote");
    expect(await readFile(path.join(tracked, "b.txt"), "utf8")).toBe("ok");
  });

  it("shows the card from /task and only records accept via /task accept", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-task-cmd-"));
    await writeAgreement(cwd, sample());
    await recordMissing(cwd, {
      criterionId: "c2",
      command: "live Windows Terminal",
      note: "no interactive console in this run",
    });
    const state = await startState(cwd, { local: true });
    const shown = await handleLine("/task", state, { mockJev: true, yes: true, local: true });
    expect(shown.output).toContain("Aegis delivery card");
    expect(shown.output).toContain("owner accepted  no");
    const confirm = await handleLine("/task confirm", state, { mockJev: true, yes: true, local: true });
    expect(confirm.output).toContain("confirmed");
    const accept = await handleLine("/task accept", state, { mockJev: true, yes: true, local: true });
    expect(accept.output).toMatch(/owner accepted  yes/);
  });

  it("blocks mutations when the agreement file is corrupt or unreadable as JSON", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-task-badjson-"));
    await writeAgreement(cwd, sample());
    await writeFile(path.join(cwd, ".harness", "task", "agreement.json"), "{not-json", "utf8");
    await expect(loadTask(cwd)).rejects.toThrow(/Broken delivery agreement/);
    const tools = createTools({
      cwd,
      guards: toolGuards(shipped()),
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => true,
      onTool: () => undefined,
    });
    const blocked = String(
      await tools.write.execute!({ path: "corrupt-write.txt", contents: "x" }, localOpts),
    );
    expect(blocked).toContain("broken delivery agreement");
    await expect(readFile(path.join(cwd, "corrupt-write.txt"), "utf8")).rejects.toThrow();
    await writeFile(
      path.join(cwd, ".harness", "task", "agreement.json"),
      `${JSON.stringify({ id: "x", status: "proposed" })}\n`,
      "utf8",
    );
    const schemaBlocked = String(
      await tools.write.execute!({ path: "schema-write.txt", contents: "x" }, localOpts),
    );
    expect(schemaBlocked).toContain("broken delivery agreement");
    await expect(readFile(path.join(cwd, "schema-write.txt"), "utf8")).rejects.toThrow();
  });

  it("does not attach a check executed in another project", async () => {
    const appA = await mkdtemp(path.join(os.tmpdir(), "aegis-app-a-"));
    const appB = await mkdtemp(path.join(os.tmpdir(), "aegis-app-b-"));
    await writeFile(path.join(appA, "check.cjs"), "process.exit(1);\n", "utf8");
    await writeFile(path.join(appB, "check.cjs"), "process.exit(0);\n", "utf8");
    await writeAgreement(appA, sample());
    await expect(
      runCheck(appA, {
        criterionId: "c1",
        argv: [process.execPath, "check.cjs"],
        workdir: appB,
      }),
    ).rejects.toThrow(/agreed task directory/);
    const empty = await loadTask(appA);
    expect(empty?.checks).toEqual([]);
    const local = await runCheck(appA, {
      criterionId: "c1",
      argv: [process.execPath, "check.cjs"],
    });
    expect(local.workdir).toBe(path.resolve(appA));
    expect(local.status).toBe("failed");
    expect(local.exitCode).toBe(1);
    const task = await loadTask(appA);
    expect(isVerifiedCheck(task!.checks.at(-1)!, task!.agreement.acceptance[0]!, task!)).toBe(false);
  });

  it("invalidates evidence when only the approved reference changes", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-task-ref-"));
    await writeFile(path.join(cwd, "screen-a.txt"), "approved-a\n", "utf8");
    await writeFile(path.join(cwd, "screen-b.txt"), "approved-b\n", "utf8");
    await writeAgreement(cwd, { ...sample(), references: ["screen-a.txt"] });
    await runCheck(cwd, {
      criterionId: "c1",
      argv: [process.execPath, "-e", "process.stdout.write('ok'); process.exit(0)"],
    });
    const before = await loadTask(cwd);
    const last = before!.checks.at(-1)!;
    expect(last.stale).toBe(false);
    expect(isVerifiedCheck(last, before!.agreement.acceptance[0]!, before!)).toBe(true);
    await writeFile(path.join(cwd, "screen-a.txt"), "approved-a-edited\n", "utf8");
    const afterBody = await loadTask(cwd);
    expect(afterBody!.checks.at(-1)?.stale).toBe(true);
    expect(isVerifiedCheck(afterBody!.checks.at(-1)!, afterBody!.agreement.acceptance[0]!, afterBody!)).toBe(
      false,
    );
    await writeFile(path.join(cwd, "screen-a.txt"), "approved-a\n", "utf8");
    const restored = await loadTask(cwd);
    expect(isVerifiedCheck(restored!.checks.at(-1)!, restored!.agreement.acceptance[0]!, restored!)).toBe(true);
    const revision = await reviseAgreement(
      cwd,
      {
        objective: sample().objective,
        scope: sample().scope,
        acceptance: sample().acceptance,
        exclusions: sample().exclusions,
        references: ["screen-b.txt"],
      },
      { reason: "new approved screen" },
    );
    expect(revision.meaningChanged).toBe(true);
    const after = await loadTask(cwd);
    expect(after!.agreement.status).toBe("proposed");
    expect(after!.agreement.references).toEqual(["screen-b.txt"]);
    expect(after!.checks).toHaveLength(1);
    expect(after!.checks[0]?.stale).toBe(true);
    expect(after!.checks[0]?.status).toBe("passed");
    expect(isVerifiedCheck(after!.checks[0]!, after!.agreement.acceptance[0]!, after!)).toBe(false);
  });
});
