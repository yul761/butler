import { defineConfig } from "@playwright/test";

/**
 * 演示素材的录制（BTL-251）：不是测试，不进 CI。`pnpm demo:record` 用它跑 e2e/demo/*.demo.ts，
 * 在 e2e 的沙盒里（假 claude、假 gh、临时目录）启动 Butler，产出 docs/media/ 下的动图和截图。
 */
export default defineConfig({
  testDir: "e2e/demo",
  testMatch: "*.demo.ts",
  timeout: 600_000,
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/demo",
});
