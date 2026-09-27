export function millicentsFromUsage(_inputTokens, _outputTokens) {
    return 0;
}
export function formatTurnHandoff(input) {
    const model = input.modelText.replace(/^\(no text\)\s*$/i, "").trim();
    const denied = input.tools.filter((tool) => !tool.approved && tool.deniedReason);
    const lines = [
        `Outcome  ${input.outcome}`,
        input.taskId
            ? `Task  ${input.taskId}${input.taskFingerprint ? `  hash ${input.taskFingerprint}` : ""}`
            : "Task  (none)",
    ];
    if (input.block)
        lines.push(`Blocked  ${input.block}`);
    if (denied.length) {
        for (const tool of denied) {
            lines.push(`Denied  ${tool.name}${tool.target ? ` ${tool.target}` : ""}  ${tool.deniedReason}`);
        }
    }
    lines.push("Changed", ...(input.changed.length ? input.changed.map((file) => `- ${file}`) : ["- (none this turn)"]), "Checks run", ...(input.checks.length ? input.checks.map((item) => `- ${item}`) : ["- (none this turn)"]), `Next  ${input.next}`);
    if (input.finishReason || input.steps !== undefined) {
        lines.push(`Diag  finish=${input.finishReason ?? "unknown"}  steps=${input.steps ?? 0}`);
    }
    if (model) {
        lines.push("", model);
    }
    return lines.join("\n");
}
export function formatReceipt(receipt) {
    const kindOdds = Object.entries(receipt.turn.probabilities.kind)
        .map(([key, value]) => `${key}=${value.toFixed(2)}`)
        .join(" ");
    const toolLines = receipt.tools.length
        ? receipt.tools
            .map((tool) => {
            const deny = tool.deniedReason ? `  ${tool.deniedReason}` : "";
            const via = tool.source ? `  via ${tool.source}${tool.rule ? ` "${tool.rule}"` : ""}` : "";
            const agent = tool.via ? `  (agent ${tool.via})` : "";
            return `  ${tool.name}${agent}  ${tool.class}  data_loss=${tool.dataLoss.toFixed(2)}  ${tool.action}  ${tool.approved ? "ran" : "denied"}${via}${deny}`;
        })
            .join("\n")
        : "  (none)";
    return [
        "── receipt ──",
        `model       ${receipt.model}  (${receipt.routeReason})`,
        `turn        ${receipt.turn.kind}  difficulty=${receipt.turn.difficultyLabel}  repo_wide=${receipt.turn.needsRepoWide.toFixed(2)}  conf=${receipt.turn.confidence.toFixed(2)}  via ${receipt.turn.source}`,
        `kind odds   ${kindOdds}`,
        `tools`,
        toolLines,
        `time        ${receipt.ms} ms`,
        `cost        unpriced`,
        "─────────────",
        receipt.text,
    ].join("\n");
}
export function formatChat(receipt) {
    const tools = receipt.tools.map((tool) => {
        if (tool.approved)
            return `tool  ${tool.name}${tool.target ? ` ${tool.target}` : ""}  ran`;
        return `tool  ${tool.name}${tool.target ? ` ${tool.target}` : ""}  denied  ${tool.deniedReason ?? ""}`.trim();
    });
    const body = receipt.text.trim() || formatTurnHandoff({
        modelText: "",
        outcome: receipt.outcome ?? "incomplete",
        tools: receipt.tools,
        block: receipt.tools.find((tool) => tool.deniedReason)?.deniedReason,
        finishReason: receipt.finishReason,
        steps: receipt.steps,
        changed: [],
        checks: [],
        next: "Inspect /task and the receipt.",
        taskId: receipt.taskId,
        taskFingerprint: receipt.taskFingerprint,
    });
    const tokens = formatTokenLine(receipt.tokens);
    return [...(tools.length ? [...tools, ""] : []), body, ...(tokens ? ["", `tokens  ${tokens}`] : [])].join("\n");
}
/** 830 · 1.2k · 12k · 1.2M — the same short form Pi's footer uses. */
export function formatTokens(count) {
    if (count < 1000)
        return String(count);
    if (count < 10_000)
        return `${(count / 1000).toFixed(1)}k`;
    if (count < 1_000_000)
        return `${Math.round(count / 1000)}k`;
    if (count < 10_000_000)
        return `${(count / 1_000_000).toFixed(1)}M`;
    return `${Math.round(count / 1_000_000)}M`;
}
/** "↑ 12k ↓ 830" (+ " · 410 thinking" when the provider reports reasoning tokens). */
export function formatTokenLine(tokens) {
    if (!tokens || (!tokens.input && !tokens.output))
        return "";
    const thinking = tokens.reasoning ? ` · ${formatTokens(tokens.reasoning)} thinking` : "";
    return `↑ ${formatTokens(tokens.input)} ↓ ${formatTokens(tokens.output)}${thinking}`;
}
