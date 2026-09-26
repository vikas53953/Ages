/**
 * Skills (the agentskills.io SKILL.md standard shared by Claude Code, Codex, OpenCode and Pi) and custom slash
 * commands (commands/<name>.md), loaded on demand.
 *
 * - Only each skill's name and description go in the system prompt; the model loads the body with the `skill`
 *   tool, which passes the lock like a read (allow rule "skill *").
 * - Yours (~/.aegis, ~/.agents, ~/.claude) are trusted. A project's (.aegis, .agents, .claude in the folder) are
 *   text written by whoever wrote the repo: they are used only after /skills trust, and that trust is tied to
 *   their exact content (change a file and it asks again).
 * - Frontmatter fields Aegis does not honour (allowed-tools, model, hooks) are ignored: your rules decide.
 * - A command's `!cmd` lines are never run; a command can never replace a built-in command.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { userAegisDir } from "./env.js";
import { projectKey } from "./rules.js";
/** Tool names an agent file may list (Aegis's, or Claude Code's), and what they become. Others are ignored. */
const AGENT_TOOLS = {
    read: "read", grep: "grep", glob: "glob", skill: "skill", webfetch: "webfetch", websearch: "websearch",
    write: "write", edit: "edit", multi_edit: "multi_edit", multiedit: "multi_edit", shell: "shell", bash: "shell", powershell: "shell",
};
export const DEFAULT_AGENT_TOOLS = ["read", "grep", "glob"];
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILE = 200_000;
const MAX_PROMPT_BLOCK = 8_000;
/** Frontmatter between --- lines: key: value, quoted values, booleans, and > / | block scalars. */
export function parseFrontmatter(text) {
    const match = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!match)
        return { data: {}, body: text };
    const data = {};
    const lines = (match[1] ?? "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
        const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
        if (!kv)
            continue;
        const key = kv[1];
        let value = kv[2].trim();
        if (value === ">" || value === "|" || value === ">-" || value === "|-") {
            const block = [];
            while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === ""))
                block.push(lines[++i].trim());
            value = value.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
        }
        else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        data[key] = value === "true" ? true : value === "false" ? false : value;
    }
    return { data, body: text.slice(match[0].length) };
}
function roots(cwd) {
    const home = os.homedir();
    return {
        skills: [
            { dir: path.join(cwd, ".aegis", "skills"), scope: "project", source: ".aegis/skills" },
            { dir: path.join(cwd, ".agents", "skills"), scope: "project", source: ".agents/skills" },
            { dir: path.join(cwd, ".claude", "skills"), scope: "project", source: ".claude/skills" },
            { dir: path.join(userAegisDir(), "skills"), scope: "user", source: "~/.aegis/skills" },
            { dir: path.join(home, ".agents", "skills"), scope: "user", source: "~/.agents/skills" },
            { dir: path.join(home, ".claude", "skills"), scope: "user", source: "~/.claude/skills" },
        ],
        commands: [
            { dir: path.join(cwd, ".aegis", "commands"), scope: "project", source: ".aegis/commands" },
            { dir: path.join(userAegisDir(), "commands"), scope: "user", source: "~/.aegis/commands" },
        ],
        agents: [
            { dir: path.join(cwd, ".aegis", "agents"), scope: "project", source: ".aegis/agents" },
            { dir: path.join(cwd, ".claude", "agents"), scope: "project", source: ".claude/agents" },
            { dir: path.join(userAegisDir(), "agents"), scope: "user", source: "~/.aegis/agents" },
            { dir: path.join(home, ".claude", "agents"), scope: "user", source: "~/.claude/agents" },
        ],
    };
}
async function readSmall(file) {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_FILE)
        return undefined;
    return readFile(file, "utf8");
}
async function scanSkills(cwd) {
    const found = [];
    for (const root of roots(cwd).skills) {
        let names = [];
        try {
            names = (await readdir(root.dir)).sort();
        }
        catch {
            continue;
        }
        for (const folder of names) {
            // A skill folder that is a link could point anywhere: only real folders count.
            if ((await lstat(path.join(root.dir, folder)).catch(() => undefined))?.isSymbolicLink())
                continue;
            const file = path.join(root.dir, folder, "SKILL.md");
            const text = await readSmall(file).catch(() => undefined);
            if (!text)
                continue;
            const { data } = parseFrontmatter(text);
            const declared = typeof data.name === "string" ? data.name.trim().toLowerCase() : "";
            const name = NAME.test(declared) ? declared : folder.toLowerCase();
            if (!NAME.test(name))
                continue;
            found.push({
                name,
                description: String(data.description ?? "").slice(0, 1024),
                dir: path.join(root.dir, folder),
                file,
                scope: root.scope,
                source: root.source,
                modelInvocable: data["disable-model-invocation"] !== true,
                argumentHint: typeof data["argument-hint"] === "string" ? data["argument-hint"] : undefined,
            });
        }
    }
    return found;
}
async function scanCommands(cwd) {
    const found = [];
    for (const root of roots(cwd).commands) {
        let names = [];
        try {
            names = (await readdir(root.dir)).filter((name) => /\.md$/i.test(name)).sort();
        }
        catch {
            continue;
        }
        for (const fileName of names) {
            const name = fileName.slice(0, -3).toLowerCase();
            if (!NAME.test(name))
                continue;
            const file = path.join(root.dir, fileName);
            const text = await readSmall(file).catch(() => undefined);
            if (text === undefined)
                continue;
            const { data, body } = parseFrontmatter(text);
            const firstLine = body.trim().split(/\r?\n/)[0] ?? "";
            found.push({
                name,
                description: String(data.description ?? firstLine).slice(0, 200),
                file,
                scope: root.scope,
                source: root.source,
                argumentHint: typeof data["argument-hint"] === "string" ? data["argument-hint"] : undefined,
            });
        }
    }
    return found;
}
async function scanAgents(cwd) {
    const found = [];
    for (const root of roots(cwd).agents) {
        let names = [];
        try {
            names = (await readdir(root.dir)).filter((name) => /\.md$/i.test(name)).sort();
        }
        catch {
            continue;
        }
        for (const fileName of names) {
            const file = path.join(root.dir, fileName);
            const text = await readSmall(file).catch(() => undefined);
            if (!text)
                continue;
            const { data, body } = parseFrontmatter(text);
            const declared = typeof data.name === "string" ? data.name.trim().toLowerCase() : "";
            const name = NAME.test(declared) ? declared : fileName.slice(0, -3).toLowerCase();
            if (!NAME.test(name) || !body.trim())
                continue;
            const listed = typeof data.tools === "string"
                ? data.tools.split(/[,\s]+/).map((tool) => AGENT_TOOLS[tool.trim().toLowerCase()]).filter((tool) => Boolean(tool))
                : [];
            found.push({
                name,
                description: String(data.description ?? "").replace(/\s+/g, " ").slice(0, 500),
                file,
                scope: root.scope,
                source: root.source,
                tools: listed.length ? [...new Set(listed)] : [...DEFAULT_AGENT_TOOLS],
                model: /^(cheap|haiku|fast)$/i.test(String(data.model ?? "")) ? "cheap" : "inherit",
                instructions: body.trim(),
            });
        }
    }
    return found;
}
/** An agent's instructions: the text read with the file, so an edit made during a turn cannot slip in. */
export async function agentInstructions(agent) {
    return agent.instructions;
}
/** The system prompt block for custom agents: names and descriptions only. */
export function agentsPromptBlock(agents) {
    if (!agents.length)
        return "";
    const lines = ["## Agents", "Hand a task to one of these with the agent tool when it matches; it works in a fresh conversation and reports back:"];
    let size = lines.join("\n").length;
    for (const agent of agents.slice(0, 30)) {
        const line = `- ${agent.name}: ${agent.description || "(no description)"} [tools: ${agent.tools.join(", ")}]`;
        if (size + line.length > MAX_PROMPT_BLOCK)
            break;
        lines.push(line);
        size += line.length + 1;
    }
    return lines.join("\n");
}
function trustFile() {
    return path.join(userAegisDir(), "extensions-trust.json");
}
/** One hash over every project skill and command file (path + content): change anything and trust is gone. */
async function projectFingerprint(skills, commands, cwd, agents = []) {
    // Keyed by the project (a worktree is its main checkout), so trust given in one applies in the other.
    const hash = createHash("sha256").update(projectKey(cwd));
    const skillFiles = [];
    for (const skill of skills.filter((row) => row.scope === "project")) {
        skillFiles.push(skill.file, ...(await listFiles(skill.dir, 200)).map((file) => path.join(skill.dir, file)));
    }
    const files = [
        ...skillFiles,
        ...commands.filter((command) => command.scope === "project").map((command) => command.file),
        ...agents.filter((agent) => agent.scope === "project").map((agent) => agent.file),
    ].sort();
    for (const file of files) {
        hash.update(`\0${path.relative(cwd, file)}\0`);
        hash.update(await readFile(file).catch(() => Buffer.alloc(0)));
    }
    return { hash: hash.digest("hex").slice(0, 32), count: files.length };
}
function readTrust() {
    try {
        return JSON.parse(readFileSync(trustFile(), "utf8"));
    }
    catch {
        return {};
    }
}
/** Everything usable here: yours, plus the project's if you trusted them as they are. First name wins, yours after the project's. */
export async function loadExtensions(cwd) {
    const skills = await scanSkills(cwd);
    const commands = await scanCommands(cwd);
    const agents = await scanAgents(cwd);
    const print = await projectFingerprint(skills, commands, cwd, agents);
    const trusted = print.count > 0 && readTrust()[projectKey(cwd)] === print.hash;
    const usable = (scope) => scope === "user" || trusted;
    const pick = (rows) => {
        const seen = new Set();
        return rows.filter((row) => usable(row.scope) && !seen.has(row.name) && (seen.add(row.name), true));
    };
    // Agents: yours win a name clash, so trusting a repo never swaps the agent your "allow agent <name>" rule meant.
    const agentsYoursFirst = [...agents.filter((row) => row.scope === "user"), ...agents.filter((row) => row.scope === "project")];
    return { skills: pick(skills), commands: pick(commands), agents: pick(agentsYoursFirst), untrustedProject: trusted ? 0 : print.count };
}
/** /skills trust: trust this project's skills and commands exactly as they are now. */
export async function trustProjectExtensions(cwd) {
    const print = await projectFingerprint(await scanSkills(cwd), await scanCommands(cwd), cwd, await scanAgents(cwd));
    if (!print.count)
        return 0;
    const trust = readTrust();
    trust[projectKey(cwd)] = print.hash;
    mkdirSync(path.dirname(trustFile()), { recursive: true });
    writeFileSync(trustFile(), `${JSON.stringify(trust, null, 2)}\n`);
    return print.count;
}
/** The system prompt block: names and descriptions only. */
export function skillsPromptBlock(skills) {
    const usable = skills.filter((skill) => skill.modelInvocable && skill.description);
    if (!usable.length)
        return "";
    const lines = ["## Skills", "Load a skill with the skill tool when a task matches its description, then follow it. Only these exist:", "<available_skills>"];
    let size = lines.join("\n").length;
    for (const skill of usable) {
        const line = `- ${skill.name}: ${skill.description.replace(/\s+/g, " ")}`;
        if (size + line.length > MAX_PROMPT_BLOCK)
            break;
        lines.push(line);
        size += line.length + 1;
    }
    lines.push("</available_skills>");
    return lines.join("\n");
}
async function listFiles(dir, max = 20) {
    const out = [];
    const walk = async (current, depth) => {
        if (depth > 3 || out.length >= max)
            return;
        for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
            if (out.length >= max)
                return;
            if (entry.isSymbolicLink())
                continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory())
                await walk(full, depth + 1);
            else if (entry.isFile() && entry.name !== "SKILL.md")
                out.push(path.relative(dir, full).replaceAll("\\", "/"));
        }
    };
    await walk(dir, 0);
    return out;
}
/** What the skill tool returns: the body (or one file of the skill), marked as skill text, confined to the skill folder. */
export async function readSkill(skills, name, file) {
    const skill = skills.find((row) => row.name === String(name).toLowerCase());
    if (!skill)
        return `No skill named ${name}. Available: ${skills.map((row) => row.name).join(", ") || "none"}`;
    const open = (text, label) => `<skill name="${skill.name}" source="${skill.source}" file="${label}">\n${text}\n</skill>`;
    if (file) {
        if (path.isAbsolute(file) || /^\\\\/.test(file) || file.split(/[\\/]/).includes(".."))
            return "That file is outside the skill folder.";
        const root = await realpath(skill.dir);
        const target = await realpath(path.join(skill.dir, file)).catch(() => undefined);
        if (!target)
            return `No file ${file} in skill ${skill.name}.`;
        const inside = path.relative(root, target);
        if (inside.startsWith("..") || path.isAbsolute(inside))
            return "That file is outside the skill folder.";
        const text = await readSmall(target).catch(() => undefined);
        return text === undefined ? `${file} is too large or not a file.` : open(text, file);
    }
    const text = await readSmall(skill.file).catch(() => undefined);
    if (text === undefined)
        return `Skill ${skill.name} could not be read.`;
    const files = await listFiles(skill.dir);
    const body = parseFrontmatter(text).body.trim();
    return [
        open(body, "SKILL.md"),
        `Skill folder: ${skill.dir}`,
        files.length ? `Other files (read them with the skill tool, file: "<path>"): ${files.join(", ")}` : "",
    ]
        .filter(Boolean)
        .join("\n");
}
/** Pi's argument rules: $1…$9, $@ / $ARGUMENTS, ${1:-default}, shell-like quoting; no placeholder → appended. */
export function splitArgs(text) {
    const out = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match;
    while ((match = pattern.exec(text)))
        out.push(match[1] ?? match[2] ?? match[3] ?? "");
    return out;
}
export function expandCommand(template, argText) {
    const args = splitArgs(argText);
    let used = false;
    let out = template.replace(/\$\{(\d)(?::-([^}]*))?\}|\$(\d)|\$@|\$ARGUMENTS/g, (whole, braced, fallback, bare) => {
        used = true;
        if (whole === "$@" || whole === "$ARGUMENTS")
            return argText.trim();
        const index = Number(braced ?? bare) - 1;
        return args[index] ?? fallback ?? "";
    });
    if (!used && argText.trim())
        out = `${out.trimEnd()}\n\n${argText.trim()}`;
    return out;
}
/** The prompt a custom command sends, or undefined if the file went away. `!cmd` lines stay text. */
export async function commandPrompt(command, argText) {
    const text = await readSmall(command.file).catch(() => undefined);
    if (text === undefined)
        return undefined;
    return expandCommand(parseFrontmatter(text).body.trim(), argText);
}
export function extensionsExist(cwd) {
    const all = roots(cwd);
    return [...all.skills, ...all.commands].some((root) => existsSync(root.dir));
}
