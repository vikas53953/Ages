import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
/** Append one turn's receipt to .harness/receipts/<session>.jsonl. Messages live in the session, not here. */
export async function writeReceipt(cwd, receipt) {
    const dir = path.join(cwd, ".harness", "receipts");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${receipt.sessionId}.jsonl`);
    const { newMessages: _messages, ...record } = receipt;
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    return file;
}
/** receipts plugin: saves the spend/danger receipt of every turn. */
export function receiptsPlugin() {
    return {
        name: "receipts",
        onReceipt: async (receipt, { cwd }) => {
            await writeReceipt(cwd, receipt);
        },
    };
}
