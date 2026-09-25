/** One confirmation at a time so concurrent tool calls cannot drop a waiter. */
export function serializeConfirm(confirm) {
    let tail = Promise.resolve();
    return (question) => {
        const run = tail.then(() => confirm(question));
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}
