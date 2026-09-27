import { deliveryPlugin } from "./delivery/index.js";
import { jevPlugin } from "./jev/index.js";
import { receiptsPlugin } from "./receipts.js";
const FACTORIES = {
    jev: (opts) => jevPlugin(opts),
    delivery: () => deliveryPlugin(),
    receipts: () => receiptsPlugin(),
};
export const KNOWN_PLUGINS = Object.keys(FACTORIES);
/** Build the plugins named in settings, in that order. Unknown names are reported, not fatal. */
export function loadPlugins(names, opts = {}) {
    const plugins = [];
    const unknown = [];
    for (const name of names) {
        const factory = FACTORIES[name];
        if (factory)
            plugins.push(factory(opts));
        else
            unknown.push(name);
    }
    return { plugins, unknown };
}
