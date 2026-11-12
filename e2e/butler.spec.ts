import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test, type Sandbox } from "./fixtures";

const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");

test("the Butler 总控 page: both inbox panes on top and one terminal in its own workspace (BTL-190 5)", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 侧栏紧跟「现在」的入口。
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  const butler = page.locator(".butler-page");
  // 两栏都空也显示。
  await expect(butler.locator(".inbox-reports h3")).toContainText(S.inboxReports);
  await expect(butler.locator(".inbox-decisions h3")).toContainText(S.inboxDecisions);
  await expect(butler.locator(".inbox-reports")).toContainText(S.inboxNoReports);
  await expect(butler.locator(".inbox-decisions")).toContainText(S.inboxNoDecisions);
  // 没有仓库条。
  await expect(butler.locator(".repos-bar")).toHaveCount(0);
  await expect(butler).toContainText(S.noButlerSessions);

  // 在 ~/.butler/workspaces/_butler 里打开，只挂全局记忆和 Butler 模式的 butler-sessions，不加 --add-dir。
  const newSession = butler.getByRole("button", { name: `+ ${S.newButlerSession}`, exact: true });
  await newSession.click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const workspace = join(s.butlerHome, "workspaces", "_butler");
  await expect.poll(() => fakeLog(s)).toContain(`mcp=butler-workspace,butler-sessions cwd=${workspace} adddirs=\n`);
  await expect(butler.locator(".session .place")).toHaveText([S.butlerSession]);

  // 全局只有一个在跑：再点一次切回同一个终端，不新开。
  await newSession.click();
  await expect(butler.locator(".terminal-wrap")).toHaveCount(1);
  expect(fakeLog(s).match(/ interactive new /g)).toHaveLength(1);
});
