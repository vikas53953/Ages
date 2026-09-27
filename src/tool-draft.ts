/**
 * What a tool call looks like while the model is still writing it (Pi shows this live). The model streams a call's
 * input as JSON text in small pieces; a 16 KB file takes minutes on a slow model. This pulls the path and the text
 * written so far out of that half-finished JSON, so the screen can show "writing… 214 lines" instead of nothing.
 * Display only: the real call is parsed and checked by the lock when it is complete.
 */

/** The field that holds the text being written, per tool. */
const BODY_FIELD: Record<string, string> = { write: "contents", edit: "new_string", multi_edit: "new_string", shell: "command" };
/** Only the end of the text is decoded for the preview, so a big file costs the same on every update. */
const TAIL_CHARS = 4_000;

export type ToolDraft = { path?: string; lines: number; tail: string[] };

/** Decode the inside of a JSON string up to its closing quote (or the end of what has arrived). */
function decodeJsonText(raw: string) {
  let out = "";
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at]!;
    if (char === '"') break;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = raw[at + 1];
    if (next === undefined) break; // the rest of this escape has not arrived yet
    if (next === "u") {
      const hex = raw.slice(at + 2, at + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      at += 5;
      continue;
    }
    out += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "" : next === "b" || next === "f" ? "" : next;
    at += 1;
  }
  return out;
}

/** Path, line count and the last few lines of a tool call's input so far. */
export function readDraft(name: string, raw: string, tailLines = 4): ToolDraft {
  const pathMatch = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  const path = pathMatch ? decodeJsonText(pathMatch[1]!) : undefined;
  const field = BODY_FIELD[name];
  const bodyStart = field ? new RegExp(`"${field}"\\s*:\\s*"`).exec(raw) : null;
  if (!bodyStart) return { path, lines: 0, tail: [] };
  const body = raw.slice(bodyStart.index + bodyStart[0].length);
  // A line break inside a JSON string is always the two characters \n, so counting them counts lines.
  const lines = (body.match(/\\n/g)?.length ?? 0) + 1;
  let from = Math.max(0, body.length - TAIL_CHARS);
  // Never start inside an escape: step back to a character that is not a backslash run.
  while (from > 0 && body[from - 1] === "\\") from -= 1;
  const text = decodeJsonText(body.slice(from));
  const all = text.split("\n");
  // The first line of a cut-off tail may be partial; drop it when there is more before it.
  const whole = from > 0 ? all.slice(1) : all;
  const tail = whole.slice(-tailLines).map((line) => line.replace(/\s+$/, "").slice(0, 200));
  return { path, lines, tail };
}
