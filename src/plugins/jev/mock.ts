import type {
  DifficultyLabel,
  JevClient,
  ToolClass,
  ToolDecision,
  ToolState,
  TurnDecision,
  TurnKind,
  TurnState,
} from "../../types.ts";

const KIND_PROBS: Record<TurnKind, number> = {
  lookup: 0,
  edit: 0,
  architecture: 0,
};

const CLASS_PROBS: Record<ToolClass, number> = {
  read_only: 0,
  reversible: 0,
  irreversible: 0,
};

function kindFromPrompt(prompt: string): TurnKind {
  const text = prompt.toLowerCase();
  if (
    /architect|refactor|redesign|how should we (structure|design)|multi-file/.test(
      text,
    )
  ) {
    return "architecture";
  }
  if (/edit|write|change|fix|create|add |update |delete|remove/.test(text)) {
    return "edit";
  }
  return "lookup";
}

function difficultyFromPrompt(prompt: string, kind: TurnKind): number {
  if (kind === "architecture") return 3;
  if (/list |what files|ls\b|dir\b/.test(prompt.toLowerCase())) return 0;
  if (kind === "edit") return 2;
  return 1;
}

const LABELS: DifficultyLabel[] = ["trivial", "minor", "moderate", "hard"];

function irreversibleCommand(command: string) {
  return /remove-item|\brm\b|del \/|git push|git reset --hard|netsh|firewall|format |rmdir/i.test(
    command,
  );
}

export function mockTurn(state: TurnState): TurnDecision {
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

export function mockTool(state: ToolState): ToolDecision {
  const args = state.args as { command?: string } | undefined;
  const command = args?.command ?? "";
  let toolClass: ToolClass = "read_only";
  let dataLoss = 0.04;
  if (state.name === "write" || state.name === "edit") {
    toolClass = "reversible";
    dataLoss = 0.12;
  }
  if (state.name === "shell") {
    if (irreversibleCommand(command) || /\[System\.IO\.File\]|Delete\(|::Delete/i.test(command)) {
      toolClass = "irreversible";
      dataLoss = 0.82;
    } else if (/set-content|out-file|new-item|move-item|copy-item/i.test(command)) {
      toolClass = "reversible";
      dataLoss = 0.2;
    } else if (
      /^(get-childitem|get-content|select-string|echo |write-output|pwd|get-location)\b/i.test(
        command.trim(),
      )
    ) {
      toolClass = "read_only";
    } else {
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

export function mockJev(): JevClient {
  return {
    evaluateTurn: async (state, abortSignal) => {
      if (abortSignal?.aborted) return mockTurn(state);
      return mockTurn(state);
    },
    evaluateTool: async (state, abortSignal) => {
      if (abortSignal?.aborted) return mockTool(state);
      return mockTool(state);
    },
  };
}
