export const THINKING_LEVELS = ["off", "low", "medium", "high"];
export const THINKING_DISPLAYS = ["fold", "show", "hide"];
export const DEFAULT_THINKING = "low";
export const DEFAULT_THINKING_DISPLAY = "fold";
export function parseThinkingLevel(text) {
    const key = text.trim().toLowerCase();
    return THINKING_LEVELS.includes(key) ? key : undefined;
}
export function parseThinkingDisplay(text) {
    const key = text.trim().toLowerCase();
    if (key === "folded" || key === "fold")
        return "fold";
    if (key === "show" || key === "live" || key === "open")
        return "show";
    if (key === "hide" || key === "hidden")
        return "hide";
    return undefined;
}
/**
 * Call options that ask a model to reason at `level`, and to send its reasoning back so it can be shown.
 * AI SDK v7's own `reasoning` setting is read by the Anthropic and Google adapters; the OpenAI and
 * OpenAI-compatible adapters in this version read `reasoningEffort` from their provider options instead,
 * and OpenAI only returns readable reasoning when a summary is requested.
 * Models without reasoning ignore all of this (the SDK adds a warning, not an error).
 */
export function reasoningOptions(level, api, compatibleName = "opencode") {
    const reasoning = level === "off" ? "none" : level;
    const providerOptions = {};
    if (level !== "off") {
        if (api === "responses" || api === "chat") {
            providerOptions.openai = { reasoningEffort: level, reasoningSummary: "auto" };
        }
        if (api === "chat")
            providerOptions[compatibleName] = { reasoningEffort: level };
        if (api === "gemini")
            providerOptions.google = { thinkingConfig: { includeThoughts: true } };
    }
    return { reasoning, providerOptions };
}
