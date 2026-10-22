import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "hook/**/*.test.ts", "memory-mcp/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    // Windows runners spawn git / open StateCore several times slower; the 5 s default timed out tests there
    // that pass in about 1 s on macOS.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
  },
});
