import { readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, openSettingsTab, test } from "./fixtures";

/** 设置 → 环境检查 →「导出诊断」（BTL-242）：写一份 JSON，有性能窗口和 main.log 的最后几行。 */
test("export diagnostics writes a JSON file with perf counters and the log tail", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  await completeWizard(page, s);
  const file = join(s.dir, "diag.json");
  // 系统对话框 e2e 点不到，也不能抢焦点：换成固定路径。
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as unknown as typeof dialog.showSaveDialog;
  }, file);
  await openSettingsTab(page, "health");
  await page.getByTestId("diag-export").click();
  await expect(page.getByTestId("diag-export-result")).toHaveText(S.set.health.diagExported(file));
  const d = JSON.parse(readFileSync(file, "utf8"));
  expect(d.kind).toBe("shipherd-diagnostics");
  expect(d.app.mode).toBe("on");
  expect(d.perf.current.invokes["health:get"].n).toBeGreaterThan(0);
  expect(Array.isArray(d.logTail)).toBe(true);
  expect(d.logTail.length).toBeGreaterThan(0);
});
