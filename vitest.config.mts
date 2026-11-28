import { configDefaults, defineConfig } from "vitest/config";

const base = {
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
} as const;

export default defineConfig({
  test: {
    // *.timing.test.ts measure a time bound (secrets: 200 KB in under 50 ms). Run alongside the other files the machine
    // is busy and times double, so they get their own project: groupOrder 1 starts it only after "unit" has finished,
    // with a single worker. (No `extends: true`: it would concatenate the include lists.)
    projects: [
      {
        test: {
          ...base,
          name: "unit",
          include: ["src/**/*.test.ts", "hook/**/*.test.ts", "memory-mcp/**/*.test.ts", "e2e/demo/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.timing.test.ts"],
        },
      },
      {
        test: { ...base, name: "timing", include: ["src/**/*.timing.test.ts"], sequence: { groupOrder: 1 }, maxWorkers: 1, testTimeout: 60_000 },
      },
    ],
  },
});
