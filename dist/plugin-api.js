export function toolGuards(plugins = []) {
    return plugins.flatMap((plugin) => (plugin.guardTool ? [plugin.guardTool] : []));
}
export function scorerOf(plugins = []) {
    return plugins.find((plugin) => plugin.scorer)?.scorer;
}
