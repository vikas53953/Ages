import { readFile } from "node:fs/promises";
import path from "node:path";
const NAMES = ["AGENTS.md", "HARNESS.md"];
export async function loadContext(cwd) {
    const chunks = [];
    for (const name of NAMES) {
        try {
            const body = (await readFile(path.join(cwd, name), "utf8")).trim();
            if (body)
                chunks.push(`## ${name}\n${body}`);
        }
        catch {
            // file is optional
        }
    }
    return chunks.join("\n\n");
}
