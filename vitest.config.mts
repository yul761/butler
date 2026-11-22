import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "hook/**/*.test.ts", "memory-mcp/**/*.test.ts", "e2e/demo/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
    // Windows runners spawn git / open StateCore several times slower; the 5 s default timed out tests there
    // that pass in about 1 s on macOS.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    // git ≥ 2.47 starts a detached `git maintenance run --auto` after every commit / merge / rebase / fetch: one extra
    // process per call (expensive on Windows), still touching .git after the command returned. A fixture template
    // copied right after its last commit then races it (cpSync ENOENT under .git/objects on macOS CI, BTL-240).
    // Tests' repos are tiny and short-lived, so switch auto maintenance off for every git the tests spawn.
    env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false" },
  },
});
