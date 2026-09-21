import { formatSkills, type Skill } from "./skills.ts";

export function buildSystemPrompt(input: {
  cwd: string;
  memory: string;
  skills: Skill[];
  context?: string;
}) {
  const parts = [
    "You are Aegis, a custom coding-agent CLI. Jev locks spend and danger.",
    "Stay inside the working folder. Prefer read, grep, and edit. Use write for new files. Use shell only when those are not enough.",
    "After tools, answer in a few short lines.",
    `Working folder: ${input.cwd}`,
  ];
  if (input.context) {
    parts.push("Project context:", input.context);
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
