import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { runGatedTool } from "../src/gated.ts";
import { mockJev } from "../src/plugins/jev/mock.ts";
import { runShell } from "../src/tools/shell.ts";

describe("irreversible shell deny", () => {
  it("does not run Remove-Item when the user answers no", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "gate-deny-"));
    const target = path.join(cwd, "keep-me.txt");
    await writeFile(target, "safe", "utf8");

    const result = await runGatedTool({
      name: "shell",
      args: { command: `Remove-Item -Force "${target}"` },
      cwd,
      jev: mockJev(),
      config: loadConfig(),
      confirm: async () => false,
      execute: async () => {
        const { stdout, stderr } = await runShell(
          `Remove-Item -Force "${target}"`,
          cwd,
        );
        return [stdout, stderr].filter(Boolean).join("\n");
      },
    });

    expect(result.record.approved).toBe(false);
    expect(result.record.action).toBe("confirm");
    expect(result.record.class).toBe("irreversible");
    expect(result.output).toContain("denied");
    expect(await readFile(target, "utf8")).toBe("safe");
  });
});
