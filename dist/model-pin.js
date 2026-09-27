import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentCatalog, resolveModel } from "./catalog.js";
import { harnessRoot } from "./session.js";
export function modelFile(cwd) {
    return path.join(harnessRoot(cwd), "model");
}
export async function loadPinnedModel(cwd) {
    try {
        return (await readFile(modelFile(cwd), "utf8")).trim();
    }
    catch {
        return "";
    }
}
export async function setPinnedModel(cwd, id) {
    // Engines are not catalogue models: "claude-code" runs the Claude Code you installed and signed in to.
    const resolved = id.trim().toLowerCase() === "claude-code" ? { ok: true, id: "claude-code" } : resolveModel(id, currentCatalog());
    if (!resolved.ok)
        throw new Error(resolved.message);
    await mkdir(harnessRoot(cwd), { recursive: true });
    await writeFile(modelFile(cwd), `${resolved.id}\n`, "utf8");
    return resolved.id;
}
export async function clearPinnedModel(cwd) {
    try {
        await unlink(modelFile(cwd));
    }
    catch {
        // no pin
    }
}
export function defaultModelId(input) {
    return input.override?.trim() || input.pin?.trim() || "";
}
