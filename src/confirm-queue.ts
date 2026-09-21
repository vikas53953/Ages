export type ConfirmFn = (question: string) => Promise<boolean>;

/** One confirmation at a time so concurrent tool calls cannot drop a waiter. */
export function serializeConfirm(confirm: ConfirmFn): ConfirmFn {
  let tail = Promise.resolve();
  return (question) => {
    const run = tail.then(() => confirm(question));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
