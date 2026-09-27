import os from "node:os";
export const APP_NAME = "Aegis";
export const APP_CMD = "aegis";
export const APP_VERSION = "0.2.0";
export const APP_TAGLINE = "the agent you own";
export const APP_DIFFERENCE = "Jev locks spend and danger.";
export function displayUser() {
    if (process.env.USERNAME || process.env.USER)
        return process.env.USERNAME || process.env.USER;
    try {
        return os.userInfo().username || "there";
    }
    catch {
        return "there";
    }
}
