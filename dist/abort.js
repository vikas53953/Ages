export function waitForAbort(signal) {
    return new Promise((resolve) => {
        if (!signal)
            return;
        if (signal.aborted) {
            resolve();
            return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
}
export async function raceAbort(work, signal, onAbort) {
    if (!signal)
        return work;
    if (signal.aborted)
        return onAbort();
    return Promise.race([work, waitForAbort(signal).then(onAbort)]);
}
