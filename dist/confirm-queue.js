/** One confirmation at a time so concurrent tool calls cannot drop a waiter. */
export function serializeConfirm(confirm) {
    let tail = Promise.resolve();
    return (question, options) => {
        const run = tail.then(() => confirm(question, options));
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}
