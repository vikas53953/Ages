import type { Interface } from "node:readline";

export function queuedLines(rl: Pick<Interface, "on">) {
  const queued: string[] = [];
  let waiter: ((line: string | null) => void) | undefined;
  let closed = false;
  rl.on("line", (line) => {
    if (waiter) {
      const resume = waiter;
      waiter = undefined;
      resume(line);
    } else {
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
    if (queued.length) return Promise.resolve(queued.shift() ?? null);
    if (closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      waiter = resolve;
    });
  };
}
