import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, test } from "./fixtures";

/**
 * 用户反馈（2026-10-28）：开着盖子让 session 自己跑时，要能在 Butler 里一键开关防休眠，不用每次叫 claude 起 caffeinate。
 * 侧边栏的开关打开后主进程真的持有 powerSaveBlocker，关掉后释放；重启后默认是关的。
 * 设了 BUTLER_E2E_SHOTS_DIR 时把打开状态的侧边栏截一张图存到那里（CI 不设）。
 */
test("the keep-awake switch holds a power save blocker until turned off, and starts off", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const first = await launch(s);
  await completeWizard(first.page, s);

  const toggle = first.page.getByRole("checkbox", { name: S.keepAwake, exact: true });
  await expect(toggle).not.toBeChecked();
  // 勾选状态由主进程回报后才变（受控组件），所以用 click 再断言，不用 check()。
  await toggle.click();
  const on = first.page.getByRole("checkbox", { name: S.keepAwakeOn, exact: true });
  await expect(on).toBeChecked();
  // powerSaveBlocker 的 id 从 0 开始递增；这个进程里只有防休眠会申请，查前 32 个就够了。
  const blocking = () => first.app.evaluate(({ powerSaveBlocker }) => Array.from({ length: 32 }, (_, id) => id).some((id) => powerSaveBlocker.isStarted(id)));
  expect(await blocking()).toBe(true);
  const shots = process.env.BUTLER_E2E_SHOTS_DIR;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await first.page.locator(".sidebar").screenshot({ path: join(shots, "keep-awake-on.png") });
  }

  await on.click();
  await expect(first.page.getByRole("checkbox", { name: S.keepAwake, exact: true })).not.toBeChecked();
  expect(await blocking()).toBe(false);

  await first.page.getByRole("checkbox", { name: S.keepAwake, exact: true }).click();
  await expect(first.page.getByRole("checkbox", { name: S.keepAwakeOn, exact: true })).toBeChecked();
  await first.app.close();
  const second = await launch(s);
  await expect(second.page.getByRole("checkbox", { name: S.keepAwake, exact: true })).not.toBeChecked();
});
