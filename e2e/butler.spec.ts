import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test, type Sandbox } from "./fixtures";

const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");

test("the Butler 总控 page: both inbox tabs on top and one terminal in its own workspace (BTL-190 5)", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 侧栏紧跟「现在」的入口。
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  const butler = page.locator(".butler-page");
  // 终端上面是「汇报 / 待你决定」两个 tab，都空也显示；默认收起，点「待你决定」展开，再点「汇报」切过去。
  const tab = (name: string) => butler.locator(".page-tabs-bar").getByRole("tab", { name: new RegExp(`^${name}`) });
  await tab(S.inboxDecisions).click();
  await expect(tab(S.inboxDecisions)).toHaveAttribute("aria-selected", "true");
  await expect(butler.locator(".page-tabs-panel")).toContainText(S.inboxNoDecisions);
  await tab(S.inboxReports).click();
  await expect(tab(S.inboxReports)).toHaveAttribute("aria-selected", "true");
  await expect(butler.locator(".page-tabs-panel")).toContainText(S.inboxNoReports);
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

test("page tabs start collapsed, the toggle expands them and the choice survives a reload", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  const butler = page.locator(".butler-page");
  const toggle = butler.locator(".page-tabs-toggle");
  const tab = (name: string) => butler.locator(".page-tabs-bar").getByRole("tab", { name: new RegExp(`^${name}`) });

  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveText(`▸ ${S.tabExpand}`);
  await expect(butler.locator(".page-tabs-panel")).toHaveCount(0);
  await expect(tab(S.inboxReports)).toHaveAttribute("aria-selected", "false");
  await expect(tab(S.inboxDecisions)).toBeVisible();
  // 收起时 tab 上的计数照样显示（没有待决事项时不标红）。
  await expect(tab(S.inboxDecisions)).toHaveText(/\d/);

  // 展开：回到最近的 tab（没记过就是默认的「待你决定」）；换到「汇报」。
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(tab(S.inboxDecisions)).toHaveAttribute("aria-selected", "true");
  await tab(S.inboxReports).click();
  await page.reload();
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(tab(S.inboxReports)).toHaveAttribute("aria-selected", "true");

  // 收起后刷新，仍然收起；再展开回到「汇报」。
  await toggle.click();
  await expect(butler.locator(".page-tabs-panel")).toHaveCount(0);
  await page.reload();
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(tab(S.inboxReports)).toHaveAttribute("aria-selected", "true");
});
