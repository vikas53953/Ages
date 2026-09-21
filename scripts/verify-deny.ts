import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { runGatedTool } from "../src/gated.ts";
import { mockJev } from "../src/jev/mock.ts";
import { runShell } from "../src/tools/shell.ts";

const cwd = await mkdtemp(path.join(os.tmpdir(), "gate-verify-"));
const target = path.join(cwd, "keep-me.txt");
await writeFile(target, "still here", "utf8");

const result = await runGatedTool({
  name: "shell",
  args: { command: `Remove-Item -Force "${target}"` },
  cwd,
  jev: mockJev(),
  config: loadConfig(),
  confirm: async (question) => {
    console.log(question);
    console.log("(answered n — default)");
    return false;
  },
  execute: async () => {
    const { stdout, stderr } = await runShell(`Remove-Item -Force "${target}"`, cwd);
    return [stdout, stderr].filter(Boolean).join("\n");
  },
});

const left = await readFile(target, "utf8");
console.log(`class=${result.record.class} action=${result.record.action} approved=${result.record.approved}`);
console.log(`output=${result.output}`);
console.log(`file=${left}`);
if (result.record.approved || left !== "still here") {
  process.exitCode = 1;
}
