const KNOWN = [
    { id: "gpt-6-astra", name: "GPT 6 Astra", group: "OpenAI", api: "responses" },
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", group: "OpenAI", api: "responses" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra", group: "OpenAI", api: "responses" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", group: "OpenAI", api: "responses" },
    { id: "gpt-5.5", name: "GPT 5.5", group: "OpenAI", api: "responses" },
    { id: "gpt-5.5-pro", name: "GPT 5.5 Pro", group: "OpenAI", api: "responses" },
    { id: "gpt-5.4", name: "GPT 5.4", group: "OpenAI", api: "responses" },
    { id: "gpt-5.4-pro", name: "GPT 5.4 Pro", group: "OpenAI", api: "responses" },
    { id: "gpt-5.4-mini", name: "GPT 5.4 Mini", group: "OpenAI", api: "responses" },
    { id: "gpt-5.4-nano", name: "GPT 5.4 Nano", group: "OpenAI", api: "responses" },
    { id: "gpt-5.3-codex", name: "GPT 5.3 Codex", group: "OpenAI", api: "responses" },
    { id: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark", group: "OpenAI", api: "responses" },
    { id: "gpt-5.2", name: "GPT 5.2", group: "OpenAI", api: "responses" },
    { id: "gpt-5.2-codex", name: "GPT 5.2 Codex", group: "OpenAI", api: "responses" },
    { id: "gpt-5.1", name: "GPT 5.1", group: "OpenAI", api: "responses" },
    { id: "gpt-5.1-codex", name: "GPT 5.1 Codex", group: "OpenAI", api: "responses" },
    { id: "gpt-5.1-codex-max", name: "GPT 5.1 Codex Max", group: "OpenAI", api: "responses" },
    { id: "gpt-5.1-codex-mini", name: "GPT 5.1 Codex Mini", group: "OpenAI", api: "responses" },
    { id: "gpt-5", name: "GPT 5", group: "OpenAI", api: "responses" },
    { id: "gpt-5-codex", name: "GPT 5 Codex", group: "OpenAI", api: "responses" },
    { id: "gpt-5-nano", name: "GPT 5 Nano", group: "OpenAI", api: "responses" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", group: "Anthropic", api: "messages" },
    { id: "claude-fable-5", name: "Claude Fable 5", group: "Anthropic", api: "messages" },
    { id: "claude-opus-5", name: "Claude Opus 5", group: "Anthropic", api: "messages" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", group: "Anthropic", api: "messages" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7", group: "Anthropic", api: "messages" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", group: "Anthropic", api: "messages" },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5", group: "Anthropic", api: "messages" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", group: "Anthropic", api: "messages" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Anthropic", api: "messages" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", group: "Anthropic", api: "messages" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", group: "Anthropic", api: "messages" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", group: "Anthropic", api: "messages" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", group: "Google", api: "gemini" },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", group: "Google", api: "gemini" },
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", group: "Google", api: "gemini" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", group: "Google", api: "gemini" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", group: "Google", api: "gemini" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", group: "Google", api: "gemini" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash", group: "Google", api: "gemini" },
    { id: "grok-4.6", name: "Grok 4.6", group: "xAI", api: "responses" },
    { id: "grok-4.5", name: "Grok 4.5", group: "xAI", api: "responses" },
    { id: "grok-build-0.1", name: "Grok Build 0.1", group: "xAI", api: "responses" },
    { id: "muse-spark-1.3", name: "Muse Spark 1.3", group: "Muse", api: "responses" },
    { id: "muse-spark-1.2", name: "Muse Spark 1.2", group: "Muse", api: "responses" },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", group: "Qwen", api: "messages" },
    { id: "qwen3.7-max", name: "Qwen3.7 Max", group: "Qwen", api: "messages" },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus", group: "Qwen", api: "messages" },
    { id: "qwen3.6-plus", name: "Qwen3.6 Plus", group: "Qwen", api: "messages" },
    { id: "qwen3.5-plus", name: "Qwen3.5 Plus", group: "Qwen", api: "messages" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", group: "DeepSeek", api: "chat" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", group: "DeepSeek", api: "chat" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", group: "DeepSeek", api: "chat" },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp", group: "DeepSeek", api: "chat" },
    { id: "deepseek-v4-flash-free", name: "DeepSeek V4 Flash Free", group: "Free", api: "chat" },
    { id: "minimax-m3", name: "MiniMax M3", group: "MiniMax", api: "chat" },
    { id: "minimax-m2.7", name: "MiniMax M2.7", group: "MiniMax", api: "chat" },
    { id: "minimax-m2.5", name: "MiniMax M2.5", group: "MiniMax", api: "chat" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash", group: "GLM", api: "chat" },
    { id: "glm-5.3", name: "GLM 5.3", group: "GLM", api: "chat" },
    { id: "glm-5.2", name: "GLM 5.2", group: "GLM", api: "chat" },
    { id: "glm-5.1", name: "GLM 5.1", group: "GLM", api: "chat" },
    { id: "glm-5", name: "GLM 5", group: "GLM", api: "chat" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", group: "Kimi", api: "chat" },
    { id: "kimi-k2.6", name: "Kimi K2.6", group: "Kimi", api: "chat" },
    { id: "kimi-k3", name: "Kimi K3", group: "Kimi", api: "chat" },
    { id: "kimi-k2.5", name: "Kimi K2.5", group: "Kimi", api: "chat" },
    { id: "big-pickle", name: "Big Pickle", group: "Free", api: "chat" },
    { id: "mimo-v2.5-free", name: "MiMo-V2.5 Free", group: "Free", api: "chat" },
    { id: "ling-3.0-flash-fin-free", name: "Ling 3.0 Flash Fin Free", group: "Free", api: "chat" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", group: "Free", api: "chat" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", group: "Free", api: "chat" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", group: "Free", api: "responses" },
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", group: "Free", api: "responses" },
    { id: "jev-1.13", name: "Jev 1.13", group: "Jev", api: "systemone" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free", group: "Jev", api: "systemone" },
];
const byId = new Map(KNOWN.map((row) => [row.id, row]));
export const OPENCODE_MODELS = KNOWN;
export function normalizeModelId(id) {
    return id.trim().toLowerCase().replace(/^opencode\//, "");
}
export function inferEntry(id) {
    const known = byId.get(id);
    if (known)
        return known;
    if (id.startsWith("jev-"))
        return { id, name: prettyName(id), group: "Jev", api: "systemone" };
    if (id.startsWith("gpt-") || id.startsWith("grok-") || id.startsWith("muse-")) {
        return { id, name: prettyName(id), group: id.startsWith("gpt-") ? "OpenAI" : id.startsWith("grok-") ? "xAI" : "Muse", api: "responses" };
    }
    if (id.startsWith("claude-") || id.startsWith("qwen")) {
        return { id, name: prettyName(id), group: id.startsWith("claude-") ? "Anthropic" : "Qwen", api: "messages" };
    }
    if (id.startsWith("gemini-"))
        return { id, name: prettyName(id), group: "Google", api: "gemini" };
    if (id.includes("free") || id === "big-pickle") {
        return { id, name: prettyName(id), group: "Free", api: "chat" };
    }
    return { id, name: prettyName(id), group: "Zen", api: "chat" };
}
export function findModel(id, rows = KNOWN) {
    const needle = normalizeModelId(id);
    return rows.find((row) => row.id === needle);
}
export function resolveModel(query, rows = KNOWN) {
    const needle = normalizeModelId(query);
    if (!needle)
        return { ok: false, message: "usage: /model <id>" };
    const exact = rows.find((row) => row.id === needle);
    if (exact) {
        if (exact.api === "systemone") {
            return { ok: false, message: `${exact.id} is Jev (spend lock), not a chat model` };
        }
        return { ok: true, id: exact.id };
    }
    const prefixed = rows.filter((row) => row.id.startsWith(needle) && row.api !== "systemone");
    if (prefixed.length === 1)
        return { ok: true, id: prefixed[0].id };
    const named = rows.filter((row) => row.api !== "systemone" &&
        (row.id.includes(needle) || row.name.toLowerCase().includes(needle)));
    if (named.length === 1)
        return { ok: true, id: named[0].id };
    if (prefixed.length > 1 || named.length > 1) {
        const hits = (prefixed.length ? prefixed : named).slice(0, 8).map((row) => row.id);
        return { ok: false, message: `ambiguous. try:\n${hits.join("\n")}` };
    }
    return { ok: false, message: `unknown model ${query}. /models to list.` };
}
export function mergeCatalog(ids) {
    const seen = new Set();
    const rows = [];
    for (const raw of ids) {
        const id = normalizeModelId(raw);
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        rows.push(inferEntry(id));
    }
    if (!rows.length)
        return KNOWN;
    for (const row of KNOWN) {
        if (!seen.has(row.id))
            rows.push(row);
    }
    return rows;
}
export function formatModelList(current, rows = KNOWN) {
    const lines = [
        `current  ${current || "(none)"}`,
        "switch   /model <id>",
        "",
    ];
    let group = "";
    for (const row of rows) {
        if (row.group !== group) {
            group = row.group;
            lines.push(group);
        }
        const mark = row.id === current ? "*" : " ";
        const note = row.api === "systemone" ? "  (not chat)" : "";
        lines.push(` ${mark} ${row.id.padEnd(32)}${row.name}${note}`);
    }
    return lines.join("\n");
}
export async function fetchZenModelIds(fetcher = fetch) {
    const headers = {};
    if (process.env.OPENCODE_API_KEY) {
        headers.Authorization = `Bearer ${process.env.OPENCODE_API_KEY}`;
    }
    const response = await fetcher("https://opencode.ai/zen/v1/models", {
        headers,
        signal: AbortSignal.timeout(4000),
    });
    if (!response.ok)
        throw new Error(`models ${response.status}`);
    const body = (await response.json());
    return (body.data ?? []).map((row) => row.id ?? "").filter(Boolean);
}
let cached;
export function currentCatalog() {
    return cached ?? KNOWN;
}
export async function refreshCatalog(fetcher = fetch) {
    if (cached)
        return cached;
    try {
        cached = mergeCatalog(await fetchZenModelIds(fetcher));
    }
    catch {
        cached = KNOWN;
    }
    return cached;
}
function prettyName(id) {
    return id
        .split("-")
        .map((part) => {
        if (/^\d/.test(part))
            return part;
        if (part === "gpt")
            return "GPT";
        if (part === "glm")
            return "GLM";
        return part.charAt(0).toUpperCase() + part.slice(1);
    })
        .join(" ");
}
