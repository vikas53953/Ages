import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { inferEntry } from "./catalog.js";
export function resolveProvider(env = process.env) {
    if (env.OPENCODE_API_KEY)
        return "opencode";
    if (env.OPENAI_API_KEY)
        return "openai";
    return "local";
}
export function hasChatKey(env = process.env) {
    return resolveProvider(env) !== "local";
}
export function modelsFor(provider, config) {
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
