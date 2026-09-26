/**
 * Layer 1: the plugins Aegis ships. The core never imports these files; only the app shell (runtime.ts) does,
 * to load the names listed under "plugins" in .aegis/settings.json.
 */
import type { AegisPlugin } from "../plugin-api.ts";
import { deliveryPlugin } from "./delivery/index.ts";
import { jevPlugin } from "./jev/index.ts";
import { receiptsPlugin } from "./receipts.ts";

export type PluginOptions = { mockJev?: boolean };

const FACTORIES: Record<string, (opts: PluginOptions) => AegisPlugin> = {
  jev: (opts) => jevPlugin(opts),
  delivery: () => deliveryPlugin(),
  receipts: () => receiptsPlugin(),
};

export const KNOWN_PLUGINS = Object.keys(FACTORIES);

/** Build the plugins named in settings, in that order. Unknown names are reported, not fatal. */
export function loadPlugins(names: string[], opts: PluginOptions = {}) {
  const plugins: AegisPlugin[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const factory = FACTORIES[name];
    if (factory) plugins.push(factory(opts));
    else unknown.push(name);
  }
  return { plugins, unknown };
}
