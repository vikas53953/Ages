import { hasJevCredentials } from "../../env.js";
import { loadSettingsSafe, parseJevMode, saveJevMode, settingsPath } from "../../rules.js";
import { initialJevHealth } from "../../health.js";
import { liveJev } from "./evaluate.js";
import { mockJev } from "./mock.js";
/**
 * jev plugin: TypeSafe Jev scores each turn (cheap vs frontier) and grey-zone tool calls (auto vs ask).
 * The mode (off / second-opinion / every-call) lives in .aegis/settings.json and is set with /jev.
 */
export function jevPlugin(opts = {}) {
    return {
        name: "jev",
        scorer: opts.mockJev ? mockJev() : liveJev(),
        help: [
            "  /jev               show Jev mode and key",
            "  /jev off|second|every  set Jev mode in .aegis/settings.json",
        ],
        commands: {
            jev: async (arg, { state, opts: runOpts }) => {
                const loaded = loadSettingsSafe(state.cwd);
                if (arg) {
                    const mode = parseJevMode(arg);
                    if (!mode)
                        return { output: "usage: /jev off | second | every", session: state.session };
                    if (loaded.error) {
                        return { output: `Fix ${settingsPath(state.cwd)} first: ${loaded.error}`, session: state.session };
                    }
                    saveJevMode(state.cwd, mode);
                    state.jevHealth = initialJevHealth(runOpts.mockJev === true, mode);
                    return { output: `jev mode ${mode}  (saved to ${settingsPath(state.cwd)})`, session: state.session };
                }
                return {
                    output: [
                        `jev mode  ${loaded.settings.jev.mode}${loaded.error ? `  (settings unreadable: ${loaded.error})` : ""}`,
                        `jev key   ${hasJevCredentials() ? "present" : "missing"}`,
                        `settings  ${settingsPath(state.cwd)}`,
                        "modes     off · second (only calls no rule matches) · every (also every write/edit/shell)",
                    ].join("\n"),
                    session: state.session,
                };
            },
        },
    };
}
