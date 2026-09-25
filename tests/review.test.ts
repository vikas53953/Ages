import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { generateWith } from "../src/loop.ts";
import { collectReview, reviewPrompt } from "../src/review.ts";
import { settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
type Step = { tool: string; input: object } | { text: string };
function scripted(steps: Step[], prompts: string[]) {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const step = steps[index++] ?? { text: "done" };
      const chunks =
        "tool" in step
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: `c${index}`, toolName: step.tool, input: JSON.stringify(step.input) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: step.text },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

async function repo() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-review-"));
  git(cwd, "init", "-q", "-b", "main");
  await writeFile(path.join(cwd, "app.js"), "export const add = (a, b) => a + b;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "first");
  return cwd;
}

describe("/review collects the diff with git hardened", () => {
  it("uncommitted changes and new files; a branch; a commit", async () => {
    const cwd = await repo();
    await writeFile(path.join(cwd, "app.js"), "export const add = (a, b) => a - b;\n");
    await writeFile(path.join(cwd, "new.js"), "x\n");
    const local = await collectReview(cwd, "");
    expect("diff" in local && local.diff).toContain("-export const add = (a, b) => a + b;");
    expect("diff" in local && local.diff).toContain("new.js");
    git(cwd, "checkout", "-q", "-b", "feature");
    git(cwd, "add", ".");
    git(cwd, "commit", "-q", "-m", "second");
    const sha = git(cwd, "rev-parse", "HEAD").trim();
    const branch = await collectReview(cwd, "main focus on math");
    expect(branch).toMatchObject({ label: "changes on this branch since it split from main", instructions: "focus on math" });
    const commit = await collectReview(cwd, `commit ${sha}`);
    expect("label" in commit && commit.label).toBe(`commit ${sha}`);
    expect(await collectReview(cwd, "")).toEqual({ error: "Nothing to review: no uncommitted changes." });
  });

  it("a repo's own config cannot make git run programs (fsmonitor, external diff, textconv)", async () => {
    const cwd = await repo();
    const marker = path.join(cwd, "PWNED");
    const evil = path.join(cwd, "evil.sh");
    await writeFile(evil, `#!/bin/sh\necho pwned > "${marker}"\n`);
    await chmod(evil, 0o755);
    git(cwd, "config", "core.fsmonitor", evil);
    git(cwd, "config", "diff.external", evil);
    git(cwd, "config", "diff.evil.textconv", evil);
    await writeFile(path.join(cwd, ".gitattributes"), "*.js diff=evil\n");
    await writeFile(path.join(cwd, "app.js"), "changed\n");
    const result = await collectReview(cwd, "");
    expect("diff" in result && result.diff).toContain("+changed");
    expect(existsSync(marker)).toBe(false);
  });

  it("an option-looking argument is never passed to git as an option", async () => {
    const cwd = await repo();
    await writeFile(path.join(cwd, "app.js"), "changed\n");
    const result = await collectReview(cwd, `--output=${path.join(cwd, "written.txt")}`);
    expect(existsSync(path.join(cwd, "written.txt"))).toBe(false);
    expect("instructions" in result && result.instructions).toContain("--output=");
  });

  it("not a repository: says so", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-review-none-"));
    expect(await collectReview(cwd, "")).toMatchObject({ error: expect.stringContaining("not a git repository") });
  });
});

describe("/review turn", () => {
  it("is read-only: the model can read but not write, and the diff is marked as data", async () => {
    const cwd = await repo();
    await mkdir(path.join(cwd, ".aegis"));
    await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules: { allow: ["read *", "write *"] } }));
    await writeFile(path.join(cwd, "app.js"), "export const add = (a, b) => a - b;\n");
    const state = await startState(cwd, { local: true, mockJev: true });
    const prompts: string[] = [];
    const model = scripted(
      [
        { tool: "read", input: { path: "app.js" } },
        { tool: "write", input: { path: "app.js", contents: "fixed" } },
        { text: "[P0] app.js:1 subtracts. Verdict: patch has problems." },
      ],
      prompts,
    );
    const result = await handleLine("/review", state, { mockJev: true, yes: false, local: true, generate: generateWith(model) });
    expect(result.receipt?.tools.map((tool) => [tool.name, tool.approved])).toEqual([
      ["read", true],
      ["write", false],
    ]);
    expect(result.receipt?.tools[1]?.deniedReason).toContain("a review only reads");
    expect(prompts[0]).toContain("<untrusted_diff>");
    expect(prompts[0]).toContain("[P0]");
    expect(prompts[0]).not.toContain("You are in plan mode");
    expect(state.planMode).toBeFalsy();
    expect(reviewPrompt({ label: "x", diff: "d", truncated: true, instructions: "" })).toContain("cut at 200,000");
  });
});
