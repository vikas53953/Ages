/**
 * Runs grep/glob off the main thread, so a pattern that takes forever (a model's "(a+)+$", a slow glob, or a
 * cloned repo's .gitignore line) can be stopped: the caller terminates this worker after a deadline.
 */
import { parentPort } from "node:worker_threads";
import { globPath, grepPath } from "./grep.js";
parentPort?.on("message", async (job) => {
    try {
        const result = job.kind === "grep" ? await grepPath(job.pattern, job.path, job.cwd, job.options) : await globPath(job.pattern, job.path, job.cwd);
        parentPort?.postMessage({ ok: true, result });
    }
    catch (error) {
        parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
});
