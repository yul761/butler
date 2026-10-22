import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "hook/**/*.test.ts", "memory-mcp/**/*.test.ts"],
    environment: "node",
    passWithNoTests: true,
  },
});
