const KIND_PROBS = {
    lookup: 0,
    edit: 0,
    architecture: 0,
};
const CLASS_PROBS = {
    read_only: 0,
    reversible: 0,
    irreversible: 0,
};
function kindFromPrompt(prompt) {
    const text = prompt.toLowerCase();
    if (/architect|refactor|redesign|how should we (structure|design)|multi-file/.test(text)) {
        return "architecture";
    }
    if (/edit|write|change|fix|create|add |update |delete|remove/.test(text)) {
        return "edit";
    }
    return "lookup";
}
function difficultyFromPrompt(prompt, kind) {
    if (kind === "architecture")
        return 3;
    if (/list |what files|ls\b|dir\b/.test(prompt.toLowerCase()))
        return 0;
    if (kind === "edit")
        return 2;
    return 1;
}
const LABELS = ["trivial", "minor", "moderate", "hard"];
function irreversibleCommand(command) {
    return /remove-item|\brm\b|del \/|git push|git reset --hard|netsh|firewall|format |rmdir/i.test(command);
}
export function mockTurn(state) {
    const kind = kindFromPrompt(state.prompt);
    const difficulty = difficultyFromPrompt(state.prompt, kind);
    return {
        kind,
        difficulty,
        difficultyLabel: LABELS[difficulty] ?? "moderate",
        needsRepoWide: kind === "architecture" ? 0.8 : 0.12,
        confidence: 0.88,
        probabilities: {
            kind: { ...KIND_PROBS, [kind]: 0.88 },
        },
        source: "mock",
    };
}
export function mockTool(state) {
    const args = state.args;
    const command = args?.command ?? "";
    let toolClass = "read_only";
    let dataLoss = 0.04;
    if (state.name === "write" || state.name === "edit") {
        toolClass = "reversible";
        dataLoss = 0.12;
    }
    if (state.name === "shell") {
        if (irreversibleCommand(command) || /\[System\.IO\.File\]|Delete\(|::Delete/i.test(command)) {
            toolClass = "irreversible";
            dataLoss = 0.82;
        }
        else if (/set-content|out-file|new-item|move-item|copy-item/i.test(command)) {
            toolClass = "reversible";
            dataLoss = 0.2;
        }
        else if (/^(get-childitem|get-content|select-string|echo |write-output|pwd|get-location)\b/i.test(command.trim())) {
            toolClass = "read_only";
        }
        else {
            toolClass = "irreversible";
            dataLoss = 0.7;
        }
    }
    return {
        class: toolClass,
        dataLoss,
        confidence: 0.86,
        probabilities: { class: { ...CLASS_PROBS, [toolClass]: 0.86 } },
        source: "mock",
    };
}
export function mockJev() {
    return {
        evaluateTurn: async (state, abortSignal) => {
            if (abortSignal?.aborted)
                return mockTurn(state);
            return mockTurn(state);
        },
        evaluateTool: async (state, abortSignal) => {
            if (abortSignal?.aborted)
                return mockTool(state);
            return mockTool(state);
        },
    };
}
