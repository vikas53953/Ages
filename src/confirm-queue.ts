import type { ConfirmFn } from "./types.ts";

export type { ConfirmFn } from "./types.ts";

/** One confirmation at a time so concurrent tool calls cannot drop a waiter. */
export function serializeConfirm(confirm: ConfirmFn): ConfirmFn {
  let tail = Promise.resolve();
  return (question, options) => {
    const run = tail.then(() => confirm(question, options));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
