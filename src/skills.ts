import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type Skill = { name: string; body: string };

export async function loadSkills(cwd: string): Promise<Skill[]> {
  const dir = path.join(cwd, "skills");
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const name of names) {
    const body = (await readFile(path.join(dir, name), "utf8")).trim();
    if (body) skills.push({ name: name.replace(/\.md$/, ""), body });
  }
  return skills;
}

export function formatSkills(skills: Skill[]) {
  if (!skills.length) return "";
  return skills
    .map((skill) => `## Skill: ${skill.name}\n${skill.body}`)
    .join("\n\n");
}
