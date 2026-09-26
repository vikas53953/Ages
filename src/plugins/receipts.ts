import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AegisPlugin } from "../plugin-api.ts";
import type { Receipt } from "../types.ts";

/** Append one turn's receipt to .harness/receipts/<session>.jsonl. Messages live in the session, not here. */
export async function writeReceipt(cwd: string, receipt: Receipt) {
  const dir = path.join(cwd, ".harness", "receipts");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${receipt.sessionId}.jsonl`);
  const { newMessages: _messages, ...record } = receipt;
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  return file;
}

/** receipts plugin: saves the spend/danger receipt of every turn. */
export function receiptsPlugin(): AegisPlugin {
  return {
    name: "receipts",
    onReceipt: async (receipt, { cwd }) => {
      await writeReceipt(cwd, receipt);
    },
  };
}
