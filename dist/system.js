import { formatSkills } from "./skills.js";
export function buildSystemPrompt(input) {
    const parts = [
        "You are Aegis, a custom coding-agent CLI. Jev locks spend and danger.",
        "Stay inside the working folder. Prefer read, grep, and edit (multi_edit for several changes to one file). Use write for new files. Use shell only when those are not enough.",
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
        parts.push("Memory the operator asked you to keep:", input.memory);
    }
    const skillBlock = formatSkills(input.skills);
    if (skillBlock) {
        parts.push("Installed skills:", skillBlock);
    }
    return parts.join("\n\n");
}
