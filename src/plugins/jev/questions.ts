export const TURN_QUESTIONS = {
  kind: {
    type: "choice" as const,
    instructions:
      "What kind of coding turn is `prompt`? lookup = read, list, search, or explain existing files. edit = change files or run a normal command. architecture = design, large refactor, or a decision that spans the repo.",
    criteria: {
      lookup: "The user wants to inspect, list, search, or explain existing files.",
      edit: "The user wants to change files or run a bounded command.",
      architecture: "The user wants a design, large refactor, or repo-wide decision.",
    },
  },
  difficulty: {
    type: "score" as const,
    instructions:
      "How hard is this turn, given `cwd` and `recent_tools`? Trivial is a dir listing or a one-file read. Hard is a multi-file design or a risky change.",
    criteria: [
      "Trivial: list files, echo, or a one-line lookup",
      "Minor: read a few files or a small search",
      "Moderate: a bounded edit or a non-trivial command",
      "Hard: architecture, multi-file change, or unclear blast radius",
    ],
  },
  needs_repo_wide: {
    type: "boolean" as const,
    instructions:
      "Does answering `prompt` require reading most of the repo, not just a file or two?",
    criteria: {
      true: "Needs a repo-wide view or a change that spans many folders.",
      false: "Can be done from the prompt plus a small local look.",
    },
  },
};

export const TOOL_QUESTIONS = {
  class: {
    type: "choice" as const,
    instructions:
      "How risky is this tool call? read_only never changes the machine. reversible can be undone (a write in a git repo, a new file). irreversible deletes, pushes, or changes the network/firewall. Use `name`, `args`, and `git`.",
    criteria: {
      read_only: "read, grep, list, or any command that only prints.",
      reversible: "A file write or a command that git or a backup can undo.",
      irreversible:
        "Delete, git push, force reset, firewall, netsh, or anything that can lose data or change the network.",
    },
  },
  data_loss: {
    type: "boolean" as const,
    instructions:
      "Could this tool call destroy work that is hard to get back? Deletes, overwrite of many files, git push --force, format, or Remove-Item count as yes.",
    criteria: {
      true: "Likely deletes or overwrites work that is hard to restore.",
      false: "No lasting data loss, or the change is a normal reversible edit.",
    },
  },
};
