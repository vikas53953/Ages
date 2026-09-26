import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { codexApiBase, codexFetch, hasCodexLogin } from "./auth/codex.js";
import { inferEntry } from "./catalog.js";
/** A ChatGPT sign-in wins (you chose it most recently with /login chatgpt), then API keys. */
export function resolveProvider(env = process.env) {
    if (env.AEGIS_PROVIDER === "opencode" && env.OPENCODE_API_KEY)
        return "opencode";
    if (env.AEGIS_PROVIDER === "openai" && env.OPENAI_API_KEY)
        return "openai";
    if (hasCodexLogin())
        return "codex";
    if (env.OPENCODE_API_KEY)
        return "opencode";
    if (env.OPENAI_API_KEY)
        return "openai";
    return "local";
}
export function hasChatKey(env = process.env) {
    return resolveProvider(env) !== "local";
}
/** Models a ChatGPT plan can use through Codex. Which ones your plan includes is decided by OpenAI. */
export const CODEX_MODELS = [
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
    { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    { id: "gpt-5.3-codex-spark", name: "GPT 5.3 Codex Spark" },
];
export function modelsFor(provider, config) {
    if (provider === "codex") {
        return {
            cheap: process.env.AEGIS_CODEX_CHEAP_MODEL || "gpt-5.4-mini",
            frontier: process.env.AEGIS_CODEX_FRONTIER_MODEL || "gpt-5.5",
        };
    }
    if (provider === "opencode") {
        return {
            cheap: envOr(config.cheapModel, process.env.GATE_CHEAP_MODEL, "glm-5.3-flash"),
            frontier: envOr(config.frontierModel, process.env.GATE_FRONTIER_MODEL, "glm-5.3"),
        };
    }
    return {
        cheap: config.cheapModel,
        frontier: config.frontierModel,
    };
}
function envOr(fromConfig, fromEnv, fallback) {
    if (fromEnv)
        return fromEnv;
    if (fromConfig && fromConfig !== "gpt-4.1-mini" && fromConfig !== "gpt-4.1") {
        return fromConfig;
    }
    return fallback;
}
export function languageModel(modelId, provider = resolveProvider()) {
    if (provider === "codex")
        return codexLanguageModel(modelId);
    if (provider === "opencode") {
        return zenLanguageModel(modelId);
    }
    const client = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return client.chat(modelId);
}
function zenBase() {
    return process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1";
}
function zenLanguageModel(modelId) {
    const api = inferEntry(modelId).api;
    const apiKey = process.env.OPENCODE_API_KEY;
    const baseURL = zenBase();
    if (api === "responses") {
        return createOpenAI({ apiKey, baseURL }).responses(modelId);
    }
    if (api === "messages") {
        return createAnthropic({ apiKey, baseURL }).chat(modelId);
    }
    if (api === "gemini") {
        return createGoogleGenerativeAI({ apiKey, baseURL }).chat(modelId);
    }
    return createOpenAICompatible({
        name: "opencode",
        apiKey,
        baseURL,
    }).chatModel(modelId);
}
/** ChatGPT plan: the OpenAI Responses adapter, pointed at the Codex endpoint with your sign-in. Nothing is stored server-side. */
function codexLanguageModel(modelId) {
    const model = createOpenAI({ apiKey: "chatgpt-sign-in", baseURL: codexApiBase(), fetch: codexFetch() }).responses(modelId);
    return wrapLanguageModel({
        model,
        middleware: {
            transformParams: async ({ params }) => ({
                ...params,
                providerOptions: {
                    ...params.providerOptions,
                    openai: { ...params.providerOptions?.openai, store: false, include: ["reasoning.encrypted_content"] },
                },
            }),
        },
    });
}
