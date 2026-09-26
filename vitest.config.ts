import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // Windows runners start processes (git, PowerShell, node) slowly, and test files run in parallel: a test that
    // takes 0.3 s on Linux has passed 5 s there under load. Real hangs are still caught, at 30 s.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
  },
});
