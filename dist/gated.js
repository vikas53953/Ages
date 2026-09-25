import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "./redact.js";
import { loadHooks, runPostToolHooks, runPreToolHooks } from "./hooks.js";
import { decideToolAction, stricter } from "./policy.js";
import { raceAbort, waitForAbort } from "./abort.js";
import { isMutation, loadSettingsSafe, matchRule, saveAllowRule, suggestAllowRule } from "./rules.js";
import { isGitRepo } from "./tools/fs.js";
const DISPLAY_LIMIT = 80_000;
function clipDisplay(text) {
    if (text.length <= DISPLAY_LIMIT)
        return text;
    return `${text.slice(0, DISPLAY_LIMIT)}\n  … [${text.length - DISPLAY_LIMIT} more bytes]`;
}
/**
 * A short diff: the unchanged start and end are trimmed to two lines of context, so a one-line change in a
 * long file shows as one line, not the whole file twice.
 */
export function formatActionDiff(oldText, newText, context = 2) {
    const a = oldText.split("\n");
    const b = newText.split("\n");
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start])
        start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
    }
    if (start === a.length && start === b.length)
        return "  (no change)";
    const from = Math.max(0, start - context);
    return [
        "  --- old",
        "  +++ new",
        `  @@ line ${from + 1} @@`,
        ...a.slice(from, start).map((line) => `    ${line}`),
        ...a.slice(start, endA).map((line) => `  - ${line}`),
        ...b.slice(start, endB).map((line) => `  + ${line}`),
        ...b.slice(endB, Math.min(b.length, endB + context)).map((line) => `    ${line}`),
    ].join("\n");
}
/** The current text of the file a write would replace (inside the folder, a plain file under 2 MB), if any. */
function existingText(cwd, file) {
    if (typeof file !== "string" || !file)
        return undefined;
    try {
        // Real paths: a link that leads out of the folder shows nothing (the write itself is refused there too).
        const target = realpathSync.native(path.resolve(cwd, file));
        const relative = path.relative(realpathSync.native(path.resolve(cwd)), target);
        if (relative.startsWith("..") || path.isAbsolute(relative))
            return undefined;
        const info = statSync(target);
        if (!info.isFile() || info.size > 2_000_000)
            return undefined;
        return readFileSync(target, "utf8");
    }
    catch {
        return undefined;
    }
}
/** One change of a multi-edit in the question: long ones are cut, and say so. */
function clipEdit(text) {
    return text.length <= 4_000 ? text : `${text.slice(0, 4_000)}\n  … [this change is ${text.length - 4_000} bytes longer]`;
}
/** multi_edit's edits (a JSON string, as tool args are flat) or Claude Code's MultiEdit list. */
export function editList(value) {
    let list = value;
    if (typeof value === "string") {
        try {
            list = JSON.parse(value);
        }
        catch {
            return undefined;
        }
    }
    return Array.isArray(list) ? list : undefined;
}
export function formatConfirm(name, args, decision, why, existing) {
    const edits = name === "edit" ? editList(args.edits) : undefined;
    const details = edits
        ? [
            `  path: ${String(args.path ?? "")}  (${edits.length} edits, all or nothing)`,
            // Each change clipped, and the whole list too, so one huge change cannot bury the others.
            clipDisplay(edits.map((edit, index) => `  edit ${index + 1}:\n${clipEdit(formatActionDiff(String(edit.old_string ?? ""), String(edit.new_string ?? "")))}`).join("\n")),
        ].join("\n")
        : name === "edit" && args.edits !== undefined
            ? `  path: ${String(args.path ?? "")}\n  edits: (unreadable; answer No)`
            : name === "edit"
                ? [
                    `  path: ${String(args.path ?? "")}`,
                    clipDisplay(formatActionDiff(String(args.old_string ?? ""), String(args.new_string ?? ""))),
                ].join("\n")
                : name === "write" && existing !== undefined
                    ? [
                        `  path: ${String(args.path ?? "")}  (replaces the whole file: ${existing.split("\n").length} lines now)`,
                        clipDisplay(formatActionDiff(existing, String(args.contents ?? ""))),
                    ].join("\n")
                    : Object.entries(args)
                        .map(([key, value]) => `  ${key}: ${clipDisplay(String(value ?? ""))}`)
                        .join("\n");
    const score = decision
        ? `${decision.class}  data_loss=${decision.dataLoss.toFixed(2)}  via ${decision.source}`
        : "not scored by Jev";
    return [
        `Aegis: ${name}  ${score}`,
        why ? `  why: ${why}` : "",
        details,
        "[y/N] ",
    ]
        .filter(Boolean)
        .join("\n");
}
/** How a call looks when Jev did not score it: reads are read_only, anything that changes files counts as irreversible. */
function unscoredClass(name) {
    return isMutation(name) ? "irreversible" : "read_only";
}
function cancelled(decision, name) {
    const toolClass = decision?.class ?? unscoredClass(name);
    const record = {
        name,
        class: toolClass,
        dataLoss: decision?.dataLoss ?? (isMutation(name) ? 1 : 0),
        confidence: decision?.confidence ?? 0,
        action: "deny",
        approved: false,
        deniedReason: "cancelled",
        source: decision?.source ?? "default",
    };
    return {
        output: JSON.stringify({
            denied: true,
            reason: "cancelled",
            class: toolClass,
        }),
        record,
        decision,
    };
}
/** What plan mode lets through: reading, searching, loading a skill. */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "skill", "webfetch", "websearch", "explore"]);
/** Tools that only touch the conversation (the todo list). */
export const INTERNAL_TOOLS = new Set(["todo"]);
export function toolTarget(name, args) {
    if (name === "shell")
        return String(args.command ?? "").slice(0, 120);
    if (name === "grep" || name === "glob")
        return `"${String(args.pattern ?? "")}" in ${String(args.path ?? ".")}`;
    if (name === "webfetch")
        return String(args.url ?? "").slice(0, 200);
    if (name === "websearch")
        return `"${String(args.query ?? "").slice(0, 120)}"`;
    if (name === "websearch")
        return String(args.query ?? "").slice(0, 120);
    if (name === "explore")
        return String(args.task ?? "").slice(0, 120);
    return String(args.path ?? "");
}
function denied(input) {
    return {
        output: JSON.stringify({ denied: true, reason: input.reason, class: "irreversible" }),
        record: {
            name: input.name,
            class: "irreversible",
            dataLoss: 1,
            confidence: 1,
            action: "deny",
            approved: false,
            deniedReason: input.reason,
            target: input.target,
            source: input.source,
            rule: input.rule,
        },
    };
}
/** Should Jev score this call? off: never. second-opinion: only when no rule matched. every-call: also every mutation a rule allows or asks about. */
export function wantsJev(settings, name, rule) {
    const mode = settings.jev.mode;
    if (mode === "off")
        return false;
    if (!rule)
        return true;
    if (rule.action === "deny")
        return false;
    return mode === "every-call" && isMutation(name);
}
/** Who set the final action: the rule (unless Jev made it stricter), Jev, or nobody (default ask). */
function decidedBy(ruleAction, jevAction, decision) {
    if (ruleAction && (!jevAction || stricter(ruleAction, jevAction) === ruleAction))
        return "rule";
    if (decision)
        return decision.source;
    return "default";
}
/**
 * The checkpoint every tool call passes, in this order:
 * stop/cancel → plugin guards (delivery agreement) → rules (deny / ask / allow) → Jev (only if wanted) → you (default n) → run.
 */
export async function runGatedTool(input) {
    const target = toolTarget(input.name, input.args);
    if (input.stop?.reason) {
        const run = denied({ name: input.name, target, reason: input.stop.reason, source: "agreement" });
        run.output = JSON.stringify({ denied: true, reason: input.stop.reason, stopped: true, class: "irreversible" });
        return run;
    }
    if (input.abortSignal?.aborted) {
        return cancelled(undefined, input.name);
    }
    if (input.readOnly && !READ_ONLY_TOOLS.has(input.name) && !INTERNAL_TOOLS.has(input.name)) {
        return denied({ name: input.name, target, reason: input.readOnly, source: "agreement" });
    }
    for (const guard of input.guards ?? []) {
        const block = await guard({ name: input.name, args: input.args, cwd: input.cwd });
        if (block) {
            if (input.stop)
                input.stop.reason = block;
            return denied({ name: input.name, target, reason: block, source: "agreement" });
        }
    }
    const loaded = input.settings ? { settings: input.settings, error: input.settingsError } : loadSettingsSafe(input.cwd);
    const settings = loaded.settings;
    const rule = matchRule(settings, input.name, input.args, input.cwd);
    if (rule?.action === "deny") {
        return denied({ name: input.name, target, reason: `rule: ${rule.rule}`, source: "rule", rule: rule.rule });
    }
    // Your hooks may only tighten: deny here, or turn the call into a question below. Never allow.
    const hookConfig = input.hooks ?? loadHooks();
    const hook = await runPreToolHooks({
        config: hookConfig,
        name: input.name,
        args: input.args,
        cwd: input.cwd,
        readOnly: Boolean(input.readOnly),
        signal: input.abortSignal,
    });
    if (input.abortSignal?.aborted)
        return cancelled(undefined, input.name);
    if (hook?.action === "deny") {
        const run = denied({ name: input.name, target, reason: `hook: ${hook.reason}`, source: "hook" });
        run.record.hook = hook.hook;
        return run;
    }
    // Conversation-only tools (the todo list) change nothing outside the chat: no question, no Jev, only deny rules.
    if (INTERNAL_TOOLS.has(input.name) && !hook) {
        const output = await input.execute();
        return {
            output,
            record: { name: input.name, class: "read_only", dataLoss: 0, confidence: 1, action: "auto", approved: true, target, source: "default" },
        };
    }
    let decision;
    // The todo list is never scored, even when a hook made it a question: it changes nothing outside the chat.
    if (input.jev && !INTERNAL_TOOLS.has(input.name) && wantsJev(settings, input.name, rule)) {
        const scorer = input.jev;
        const evaluation = await raceAbort(scorer
            .evaluateTool({
            name: input.name,
            args: input.args,
            cwd: input.cwd,
            git: isGitRepo(input.cwd),
        }, input.abortSignal)
            .then((scored) => ({ kind: "decision", decision: scored })), input.abortSignal, () => ({ kind: "abort" }));
        if (evaluation.kind === "abort" || input.abortSignal?.aborted) {
            return cancelled(undefined, input.name);
        }
        decision = evaluation.decision;
    }
    const ruleAction = rule?.action === "allow" ? "auto" : rule?.action === "ask" ? "confirm" : undefined;
    const jevAction = decision ? decideToolAction(decision, input.config) : undefined;
    // A rule decides; Jev may only make it stricter. No rule and no Jev: ask.
    const decided = ruleAction
        ? jevAction
            ? stricter(ruleAction, jevAction)
            : ruleAction
        : (jevAction ?? "confirm");
    const action = hook ? stricter(decided, "confirm") : decided;
    const why = [
        rule ? `rule "${rule.rule}" → ${rule.action}` : "no rule matched",
        decision
            ? `Jev ${decision.source === "fail_closed" ? "could not score" : `→ ${jevAction}`}`
            : `Jev ${settings.jev.mode === "off" || !input.jev ? "off" : "not asked"}`,
        hook ? `hook: ${hook.reason}` : "",
        loaded.error ? `settings unreadable (${loaded.error}); allow rules ignored, Jev off` : "",
    ]
        .filter(Boolean)
        .join(" · ");
    const record = {
        name: input.name,
        class: decision?.class ?? unscoredClass(input.name),
        dataLoss: decision?.dataLoss ?? (isMutation(input.name) ? 1 : 0),
        confidence: decision?.confidence ?? (rule ? 1 : 0),
        action,
        approved: false,
        target,
        source: hook && decided !== action ? "hook" : decidedBy(ruleAction, jevAction, decision),
        rule: rule?.rule,
        hook: hook?.hook,
    };
    if (action === "confirm") {
        input.onEvent?.({ type: "awaiting_approval", name: input.name, target });
        // A rule is saved in the project's settings, so only offer one when the tool runs in the project folder
        // itself: a /task work folder's "server.mjs" is not the project's "server.mjs".
        const sameRoot = !input.settingsCwd || path.resolve(input.settingsCwd) === path.resolve(input.cwd);
        // A hook that asked is asked every time: no "always" rule can quiet it.
        const always = loaded.error || !sameRoot || hook ? undefined : suggestAllowRule(input.name, input.args, rule, input.cwd);
        const existing = input.name === "write" ? existingText(input.cwd, input.args.path) : undefined;
        const prompt = formatConfirm(input.name, input.args, decision, why, existing);
        const raced = await Promise.race([
            input
                .confirm(prompt, { always, tool: input.name, target, why })
                .then((ok) => ({ kind: "answer", ok })),
            waitForAbort(input.abortSignal).then(() => ({ kind: "abort" })),
        ]);
        if (raced.kind === "abort" || input.abortSignal?.aborted) {
            return cancelled(decision, input.name);
        }
        if (raced.ok === "always" && always) {
            // Save it so the lock learns: next time this call is allowed by your rule, without asking.
            // If the file cannot be written, the answer still counts as "yes" for this one call.
            try {
                saveAllowRule(input.settingsCwd ?? input.cwd, always);
                if (!settings.rules.allow.includes(always))
                    settings.rules.allow = [...settings.rules.allow, always];
                record.savedRule = always;
            }
            catch (error) {
                // The call runs once; nothing is remembered, and the tool line says why.
                record.saveFailed = error instanceof Error ? error.message : String(error);
            }
        }
        if (!raced.ok) {
            record.deniedReason = "user declined";
            return {
                output: JSON.stringify({
                    denied: true,
                    reason: "user declined",
                    class: record.class,
                }),
                record,
                decision,
            };
        }
    }
    if (input.abortSignal?.aborted) {
        return cancelled(decision, input.name);
    }
    record.approved = true;
    let output = await input.execute();
    // Your PostToolUse hooks (a linter, a secret scanner) see the result; what they report goes back with it.
    const notes = await runPostToolHooks({ config: hookConfig, name: input.name, args: input.args, output, cwd: input.cwd, signal: input.abortSignal });
    if (notes.length)
        output = `${output}\n${notes.join("\n")}`;
    return { output: redacted(output, record), record, decision };
}
/** Tool output on its way to the model: secret-looking values are cut and the record says how many. */
function redacted(output, record) {
    const cut = redactSecrets(output);
    if (!cut.count)
        return output;
    record.redacted = cut.count;
    return `${cut.text}\n[Aegis redacted ${cut.count} secret-looking value(s) before this reached you.]`;
}
