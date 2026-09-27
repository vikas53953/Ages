export function queuedLines(rl) {
    const queued = [];
    let waiter;
    let closed = false;
    rl.on("line", (line) => {
        if (waiter) {
            const resume = waiter;
            waiter = undefined;
            resume(line);
        }
        else {
            queued.push(line);
        }
    });
    rl.on("close", () => {
        closed = true;
        if (waiter) {
            const resume = waiter;
            waiter = undefined;
            resume(null);
        }
    });
    return () => {
        if (queued.length)
            return Promise.resolve(queued.shift() ?? null);
        if (closed)
            return Promise.resolve(null);
        return new Promise((resolve) => {
            waiter = resolve;
        });
    };
}
