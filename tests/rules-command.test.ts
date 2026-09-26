import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLine } from "../src/commands.ts";
import { describeRules, loadSettings, matchRule, saveAllowRule, settingsPath } from "../src/rules.ts";
import { handleLine, startState } from "../src/runtime.ts";

async function project(rules: object) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "aegis-rules-cmd-"));
  await mkdir(path.join(cwd, ".aegis"));
  await writeFile(settingsPath(cwd), JSON.stringify({ jev: { mode: "off" }, rules }));
  return cwd;
}
const run = async (cwd: string, line: string) =>
  (await handleLine(line, await startState(cwd, { local: true, mockJev: true }), { mockJev: true, yes: false, local: true })).output ?? "";

describe("/rules", () => {
  it("parses, with /permissions as another name", () => {
    expect(parseLine("/rules")).toEqual({ type: "rules", arg: "" });
    expect(parseLine("/permissions remove 3")).toEqual({ type: "rules", arg: "remove 3" });
  });

  it("lists every layer: built-in, always on, project, yours", async () => {
    const cwd = await project({ deny: ["webfetch *"], allow: ["shell npm test"] });
    saveAllowRule(cwd, "write docs/*");
    const rows = describeRules(cwd);
    expect(rows.find((r) => r.rule === "write .git/*")).toMatchObject({ action: "deny", source: "built-in" });
    expect(rows.find((r) => r.rule === "write .aegis/*")).toMatchObject({ action: "ask", source: "always on" });
    expect(rows.find((r) => r.rule === "webfetch *")).toMatchObject({ action: "deny", source: "project" });
    expect(rows.find((r) => r.rule === "write docs/*")).toMatchObject({ action: "allow", source: "yours" });
    // setup.ts trusts projects in tests (AEGIS_TRUST_PROJECT=1).
    expect(rows.find((r) => r.rule === "shell npm test")?.source).toBe("project");
    const out = await run(cwd, "/rules");
    expect(out).toMatch(/\d+\s+allow write docs\/\*\s+· yours/);
    expect(out).toContain("deny  webfetch *  · project");
    expect(await run(cwd, "/rules docs")).not.toContain("webfetch");
  });

  it("an untrusted project's allow rules are shown as waiting", async () => {
    const saved = process.env.AEGIS_TRUST_PROJECT;
    delete process.env.AEGIS_TRUST_PROJECT;
    try {
      const cwd = await project({ allow: ["shell npm test"] });
      expect(describeRules(cwd).find((r) => r.rule === "shell npm test")?.source).toBe("project, waiting for /trust");
    } finally {
      process.env.AEGIS_TRUST_PROJECT = saved;
    }
  });

  it("removes one of yours, and nothing else; the lock stops allowing it", async () => {
    const cwd = await project({ deny: ["webfetch *"] });
    saveAllowRule(cwd, "write docs/*");
    saveAllowRule(cwd, "edit scripts/*");
    expect(matchRule(loadSettings(cwd), "write", { path: "docs/a.md" }, cwd)?.action).toBe("allow");
    const n = describeRules(cwd).findIndex((r) => r.rule === "write docs/*") + 1;
    expect(await run(cwd, `/rules remove ${n}`)).toContain("Removed: allow write docs/*");
    expect(matchRule(loadSettings(cwd), "write", { path: "docs/a.md" }, cwd)?.action).not.toBe("allow");
    expect(describeRules(cwd).some((r) => r.rule === "edit scripts/*")).toBe(true);
    const fromProject = describeRules(cwd).findIndex((r) => r.rule === "webfetch *") + 1;
    expect(await run(cwd, `/rules remove ${fromProject}`)).toContain("change it there");
    expect(await run(cwd, "/rules remove 1")).toContain("cannot be removed here");
    expect(await run(cwd, "/rules remove 999")).toContain("usage: /rules remove <n>");
  });

  it("adds stricter rules only", async () => {
    const cwd = await project({});
    expect(await run(cwd, "/rules deny webfetch *.example.com")).toContain("Saved for this folder: deny webfetch *.example.com");
    expect(matchRule(loadSettings(cwd), "webfetch", { url: "https://a.example.com/" }, cwd)?.action).toBe("deny");
    expect(await run(cwd, "/rules ask read src/*")).toContain("Saved");
    expect(await run(cwd, "/rules allow shell *")).toContain("answering 'a'");
    expect(describeRules(cwd).some((r) => r.rule === "shell *")).toBe(false);
  });
});

describe("/rules: review fixes", () => {
  it("a rule saved by you that an untrusted project also asks for is shown as yours (it is in effect)", async () => {
    const saved = process.env.AEGIS_TRUST_PROJECT;
    delete process.env.AEGIS_TRUST_PROJECT;
    try {
      const cwd = await project({ allow: ["shell npm test", "shell npm run lint"] });
      saveAllowRule(cwd, "shell npm test");
      const rows = describeRules(cwd);
      expect(rows.find((r) => r.rule === "shell npm test")?.source).toBe("yours");
      expect(rows.find((r) => r.rule === "shell npm run lint")?.source).toBe("project, waiting for /trust");
      expect(await run(cwd, "/rules remove allow shell npm test")).toContain("Removed");
    } finally {
      process.env.AEGIS_TRUST_PROJECT = saved;
    }
  });

  it("a rule must name a real tool, or it would match nothing", async () => {
    const cwd = await project({});
    expect(await run(cwd, "/rules deny *")).toContain("a rule starts with a tool name");
    expect(await run(cwd, "/rules deny mcp__github__*")).toContain("Saved");
    expect(await run(cwd, "/rules ask Shell git push*")).toContain("Saved");
    expect(matchRule(loadSettings(cwd), "shell", { command: "git push origin" }, cwd)?.action).toBe("ask");
  });

  it("ask rules are listed in the lock's order (built-in first)", async () => {
    const cwd = await project({});
    const asks = describeRules(cwd).filter((r) => r.action === "ask");
    expect(asks[0]?.source).toBe("built-in");
  });
});
