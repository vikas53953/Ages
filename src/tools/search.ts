import { Worker } from "node:worker_threads";
import type { GrepOptions } from "./grep.ts";

export const SEARCH_TIMEOUT_MS = 20_000;

/**
 * grep or glob in a worker thread with a deadline. A regular expression cannot be interrupted on the thread
 * that runs it, so a catastrophic pattern would otherwise freeze Aegis (and esc) for good.
 */
export function searchInWorker(
  job: { kind: "grep" | "glob"; pattern: string; path: string; cwd: string; options?: GrepOptions },
  signal?: AbortSignal,
  timeoutMs = SEARCH_TIMEOUT_MS,
): Promise<string> {
  // src (run with type stripping) or dist (compiled): the worker sits next to this file either way.
  const file = new URL(import.meta.url.endsWith(".ts") ? "./search-worker.ts" : "./search-worker.js", import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(file);
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          resolve(
            `${job.kind} stopped after ${Math.round(timeoutMs / 1000)} s. The pattern may be too slow (nested repeats such as (a+)+), a .gitignore line may be, or the folder is very large: narrow the pattern, path or glob.`,
          ),
        ),
      timeoutMs,
    );
    const onAbort = () => finish(() => reject(new Error("stopped")));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message: { ok: boolean; result?: string; error?: string }) =>
      finish(() => (message.ok ? resolve(message.result ?? "") : reject(new Error(message.error)))),
    );
    worker.on("error", (error) => finish(() => reject(error)));
    worker.on("exit", (code) => finish(() => reject(new Error(`search worker exited (${code})`))));
    worker.postMessage(job);
  });
}
