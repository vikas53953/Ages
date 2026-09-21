export function waitForAbort(signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function raceAbort<T, A>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => A,
): Promise<T | A> {
  if (!signal) return work;
  if (signal.aborted) return onAbort();
  return Promise.race([work, waitForAbort(signal).then(onAbort)]);
}
