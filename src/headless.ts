/**
 * Headless mode for scripts and CI: `aegis -p "task"` prints the answer; `aegis -p --json "task"` prints one
 * JSON object per line (every event, then a result). Nobody is there to answer a y/N question, so only your
 * rules decide: allow rules run, anything that would ask is denied (deny wins, as always). `--yes` is the
 * explicit, dangerous opt-in to approve every question.
 *
 * Exit codes: 0 done · 1 error · 2 done but at least one tool call was denied.
 */
import { closeState, runPrompt, startState, type AppState, type RunOpts } from "./runtime.ts";
import type { ConfirmFn, TurnEvent } from "./types.ts";

export type HeadlessLine =
  | ({ type: "event" } & { event: TurnEvent })
  | { type: "question"; question: string; answer: "denied" | "approved" }
  | {
      type: "result";
      ok: boolean;
      notice?: string;
      answer?: string;
      output?: string;
      error?: string;
      model?: string;
      session: string;
      tokens?: { input: number; output: number; reasoning?: number };
      tools: Array<{ name: string; target?: string; approved: boolean; decidedBy?: string; reason?: string }>;
      denied: number;
    };

export async function runHeadless(input: {
  prompt: string;
  cwd: string;
  opts: RunOpts;
  json: boolean;
  write: (text: string) => void;
  abortSignal?: AbortSignal;
}): Promise<number> {
  const emit = (line: HeadlessLine) => input.json && input.write(JSON.stringify(line));
  const confirm: ConfirmFn = async (question) => {
    const approve = input.opts.yes === true;
    emit({ type: "question", question, answer: approve ? "approved" : "denied" });
    return approve;
  };
  let state: AppState | undefined;
  try {
    state = await startState(input.cwd, input.opts);
    // Always a task for the model: a piped "!cmd" or "/command" is text, never run as a shell line or a command.
    const result = await runPrompt(input.prompt, state, { ...input.opts, abortSignal: input.abortSignal }, confirm, (event) =>
      emit({ type: "event", event }),
    );
    const tools = (result.receipt?.tools ?? []).map((tool) => ({
      name: tool.name,
      target: tool.target,
      approved: tool.approved,
      decidedBy: tool.rule ? `rule ${tool.rule}` : tool.source,
      reason: tool.deniedReason,
    }));
    const denied = tools.filter((tool) => !tool.approved).length;
    if (input.json) {
      emit({
        type: "result",
        ok: true,
        notice: result.notice,
        answer: result.receipt?.answer,
        output: result.receipt ? undefined : result.output,
        model: result.receipt?.model,
        session: state.session.id,
        tokens: result.receipt?.tokens,
        tools,
        denied,
      });
    } else {
      if (result.notice) process.stderr.write(`${result.notice}\n`);
      input.write((result.receipt?.answer ?? result.output ?? "").trim());
      if (denied) {
        // Say why: a deny rule, or a question nobody can answer in -p mode (add an allow rule or --allow).
        const reasons = (result.receipt?.tools ?? [])
          .filter((tool) => !tool.approved)
          .map((tool) => `  ${tool.name} ${tool.target ?? ""}: ${tool.rule && tool.action === "deny" ? `denied by rule "${tool.rule}"` : "needed a yes, and nobody can answer in -p mode (use --allow or an allow rule)"}`);
        process.stderr.write(`${denied} tool call(s) denied:\n${reasons.join("\n")}\n`);
      }
    }
    return denied ? 2 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (input.json) emit({ type: "result", ok: false, error: message, session: state?.session.id ?? "", tools: [], denied: 0 });
    else process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    if (state) closeState(state);
  }
}

/**
 * The prompt from the arguments; stdin is read only when there is no argument, or with --stdin
 * (`git diff | aegis -p --stdin "review this"` joins both). Never waiting on stdin otherwise matters:
 * CI runners and other programs often leave an open pipe that never ends.
 */
export async function headlessPrompt(argPrompt: string, stdin: NodeJS.ReadableStream & { isTTY?: boolean }, readStdin = false) {
  if (stdin.isTTY || (argPrompt && !readStdin)) return argPrompt;
  let piped = "";
  for await (const chunk of stdin) piped += String(chunk);
  piped = piped.trim();
  if (!piped) return argPrompt;
  return argPrompt ? `${argPrompt}\n\n${piped}` : piped;
}
