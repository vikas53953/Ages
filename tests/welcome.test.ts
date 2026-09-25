import { describe, expect, it } from "vitest";
import { HELP, slashCommandsFromHelp } from "../src/commands.ts";
import { KEY_HINTS, SHIELD, shortPath, visibleWidth, welcomeLines, type WelcomeInfo } from "../src/welcome.ts";
import { redactLogin } from "../src/login.ts";

const info: WelcomeInfo = {
  name: "Aegis",
  version: "0.2.0",
  user: "Vikas",
  model: "auto: glm-5.3-flash / glm-5.3",
  provider: "OpenCode Zen",
  cwd: "/home/vikas/Projects/gate",
  jevMode: "second-opinion",
  jevHealth: "live",
  rules: { deny: 4, ask: 13, allow: 2 },
  plugins: ["jev", "delivery", "receipts"],
  recent: [{ when: "09-25 13:05", text: "read README.md" }],
  hasChatKey: true,
};

describe("welcome screen", () => {
  it("draws a two-column box at normal widths, every line exactly the box width", () => {
    const lines = welcomeLines(info, 100, false);
    const box = lines.slice(0, lines.indexOf(lines.find((line) => line.startsWith("╰"))!) + 1);
    expect(box[0]).toMatch(/^╭─── Aegis v0\.2\.0 ─+╮$/);
    for (const line of box) expect(visibleWidth(line)).toBe(100);
    const text = lines.join("\n");
    expect(text).toContain("Welcome back, Vikas!");
    for (const row of SHIELD) expect(text).toContain(row.trim());
    expect(text).toContain("rules    4 deny · 13 ask · 2 allow");
    expect(text).toContain("jev      second-opinion · live");
    expect(text).toContain("09-25 13:05  read README.md");
    expect(text).toContain(KEY_HINTS[0]!);
  });

  it("keeps widths exact with colour codes on", () => {
    const lines = welcomeLines(info, 90, true);
    for (const line of lines.slice(0, lines.findIndex((l) => l.includes("╰")) + 1)) {
      expect(visibleWidth(line)).toBe(90);
    }
  });

  it("stacks into one column on a narrow terminal and shrinks to Pi size below that", () => {
    const narrow = welcomeLines(info, 60, false);
    expect(narrow.join("\n")).toContain("Welcome back, Vikas!");
    expect(narrow.join("\n")).not.toContain(SHIELD[0]);
    expect(welcomeLines(info, 30, false)[0]).toBe("Aegis v0.2.0");
  });

  it("tells a new user how to connect a model", () => {
    const text = welcomeLines({ ...info, hasChatKey: false }, 100, false).join("\n");
    expect(text).toContain("/login opencode <key>");
  });

  it("shortens paths under home to ~", () => {
    expect(shortPath("/home/vikas/Projects/gate", 40, "/home/vikas")).toMatch(/^~.Projects.gate$/);
    expect(shortPath("/home/vikas/a/very/long/path/that/keeps/going", 12, "/home/vikas")).toMatch(/^….{11}$/);
  });
});

describe("slash autocomplete and /login", () => {
  it("builds the / list from the help text", () => {
    const commands = slashCommandsFromHelp(HELP.split("\n"));
    expect(commands.find((c) => c.name === "model")).toMatchObject({ argumentHint: "[auto|<id>]" });
    expect(commands.find((c) => c.name === "resume")).toMatchObject({ argumentHint: "<n>" });
    expect(commands.map((c) => c.name)).toContain("login");
  });

  it("never echoes a /login key", () => {
    expect(redactLogin("/login opencode sk-live-123456")).toBe("/login opencode ••••3456");
    expect(redactLogin("/login")).toBe("/login");
    expect(redactLogin("hello")).toBe("hello");
  });
});
