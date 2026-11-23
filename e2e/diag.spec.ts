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

/** 渲染进程崩了（BTL-262）：记下原因和退出码，自动重新加载，导出诊断里能看到这条记录。 */
test("a renderer crash is logged with its reason, the window reloads, and the diagnostics show it", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { app, page } = await launch(s);
  await completeWizard(page, s);
  const file = join(s.dir, "diag.json");
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as unknown as typeof dialog.showSaveDialog;
  }, file);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
  // 崩了以后等一秒再重新加载：新的渲染进程起来、界面又画出来了。Playwright 接不回崩过的页面，从主进程看。
  await expect.poll(() => app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    if (wc.isCrashed() || wc.isLoading()) return false;
    return wc.executeJavaScript("document.querySelector('.sidebar') !== null").catch(() => false);
  }), { timeout: 15_000 }).toBe(true);
  const exported = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("window.shipherd.invoke(\"diag:export\")"));
  expect(exported).toEqual({ ok: true, value: file });
  const d = JSON.parse(readFileSync(file, "utf8"));
  const gone = d.renderer.events.find((e: { kind: string }) => e.kind === "gone");
  expect(gone).toMatchObject({ action: "reload" });
  expect(typeof gone.reason).toBe("string");
  expect(typeof gone.exitCode).toBe("number");
  expect(d.renderer.events.some((e: { kind: string; by?: string }) => e.kind === "reloaded" && e.by === "auto")).toBe(true);
  expect(d.logTail.some((l: string) => l.includes("renderer: process gone (reason="))).toBe(true);
});
