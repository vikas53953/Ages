/**
 * @file mentions (Claude Code, Pi): "explain @src/loop.ts" attaches that file to the prompt, and "@src/" lists a
 * folder. Each attachment is a read that passes the lock like any other ("deny read .env" still wins), and
 * only paths that exist inside the project count, so an email address or a decorator stays plain text.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { runGatedTool } from "./gated.ts";
import type { Settings } from "./rules.ts";
import { readPath } from "./tools/read.ts";
import type { ConfirmFn, GateConfig, ToolRecord, TurnEvent } from "./types.ts";

const MAX_MENTIONS = 10;
const MENTION = /(^|\s)@([^\s@"'`<>|]+)/g;

/** The @paths in a prompt that name something in the folder, in order, without duplicates. */
export function findMentions(prompt: string, cwd: string) {
  const found: string[] = [];
  for (const match of prompt.matchAll(MENTION)) {
    const raw = match[2]!.replace(/[.,;:!?)\]]+$/, "");
    if (!raw || found.includes(raw)) continue;
    const absolute = path.resolve(cwd, raw);
    const relative = path.relative(path.resolve(cwd), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(absolute)) continue;
    found.push(raw);
    if (found.length >= MAX_MENTIONS) break;
  }
  return found;
}

/** The prompt with each allowed @path's contents appended; the tool records say what was read or refused. */
export async function attachMentions(input: {
  prompt: string;
  cwd: string;
  config: GateConfig;
  confirm: ConfirmFn;
  settings: Settings;
  settingsError?: string;
  abortSignal?: AbortSignal;
  onEvent?: (event: TurnEvent) => void;
}): Promise<{ prompt: string; records: ToolRecord[] }> {
  const mentions = findMentions(input.prompt, input.cwd);
  if (!mentions.length) return { prompt: input.prompt, records: [] };
  const blocks: string[] = [];
  const records: ToolRecord[] = [];
  for (const mention of mentions) {
    const run = await runGatedTool({
      name: "read",
      args: { path: mention },
      cwd: input.cwd,
      config: input.config,
      confirm: input.confirm,
      settings: input.settings,
      settingsError: input.settingsError,
      abortSignal: input.abortSignal,
      onEvent: input.onEvent,
      execute: () => readPath(mention, input.cwd),
    });
    records.push(run.record);
    input.onEvent?.({ type: "tool", record: run.record });
    if (run.record.approved) {
      blocks.push(`<attached path="${mention.replace(/"/g, "%22")}">\n${run.output}\n</attached>`);
    } else {
      blocks.push(`(@${mention} was not attached: ${run.record.deniedReason ?? "not allowed"})`);
    }
  }
  return { prompt: `${input.prompt}\n\n${blocks.join("\n\n")}`, records };
}
