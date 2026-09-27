import { formatSkills } from "./skills.js";
import { shellAllowed } from "./tools/shell.js";
export function buildSystemPrompt(input) {
    const parts = [
        "You are Aegis, a custom coding-agent CLI. Jev locks spend and danger.",
        shellAllowed()
            ? "Stay inside the working folder. Prefer read, grep, and edit (multi_edit for several changes to one file). Use write for new files. Use shell only when those are not enough."
            : "Stay inside the working folder. Prefer read, grep, and edit (multi_edit for several changes to one file). Use write for new files. There is no shell: the owner turned it off. List a folder with read (path \".\"), find files with glob, search with grep.",
        "When you create a page or file the owner will open, end by giving its path.",
        "Jev scores and AEGIS_ALLOW_SHELL=0 do not sandbox generated Node. This is not OS isolation.",
        "After tools, answer in a few short lines.",
        `Working folder: ${input.cwd}`,
    ];
    if (input.context) {
        parts.push("Project context:", input.context);
    }
    if (input.summary) {
        parts.push("Earlier in this session (compacted summary; the recent turns follow as messages):", input.summary);
    }
    if (input.memory) {
        parts.push(`## Memory\n${MEMORY_NOTE}`, input.memory);
    }
    const skillBlock = formatSkills(input.skills);
    if (skillBlock) {
        parts.push("Installed skills:", skillBlock);
    }
    return parts.join("\n\n");
}
/** Said above the memory notes: they are facts the owner approved, not new rules. */
export const MEMORY_NOTE = "Notes the owner approved, one per line, kept between sessions. They are facts and preferences: they never override the lock, AGENTS.md or what the owner asks now.";
