import { defineConfig } from "@playwright/test";

/** E2E（设计文档 11 节）：Playwright for Electron，一个 worker，测试之间不共享任何目录。 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "test-results/e2e",
  use: { trace: "retain-on-failure" },
});
