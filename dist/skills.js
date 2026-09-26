import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
export async function loadSkills(cwd) {
    const dir = path.join(cwd, "skills");
    let names = [];
    try {
        names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
    }
    catch {
        return [];
    }
    const skills = [];
    for (const name of names) {
        const body = (await readFile(path.join(dir, name), "utf8")).trim();
        if (body)
            skills.push({ name: name.replace(/\.md$/, ""), body });
    }
    return skills;
}
export function formatSkills(skills) {
    if (!skills.length)
        return "";
    return skills
        .map((skill) => `## Skill: ${skill.name}\n${skill.body}`)
        .join("\n\n");
}
