import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, openTab, pageTab, terminalText, test, type Sandbox } from "./fixtures";

const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");

test("the Butler 总控 page: terminal on the left, conversation on the right, one terminal in its own workspace (BTL-190 5)", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 侧栏紧跟「现在」的入口。
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  const butler = page.locator(".butler-page");
  // 没有页签（UI 重做第 3 层）：左边终端区、右边对话栏；还没有汇报时对话栏说汇报会出现在这里。
  await expect(butler.locator(".page-tabs-bar")).toHaveCount(0);
  const split = butler.locator(".control-split");
  await expect(split).toHaveCount(1);
  await expect(split.locator(".control-right .control-feed")).toContainText(S.lay.ctlEmpty);
  // 总控发出的消息默认折起，展开是空的。
  const sent = split.locator(".control-right details.butler-sent");
  await expect(sent.locator("> summary")).toHaveText(S.lay.butlerSent(0));
  await expect(sent).not.toHaveAttribute("open", /.*/);
  await sent.locator("> summary").click();
  await expect(sent).toHaveAttribute("open", "");
  await expect(sent).toContainText(S.butlerRepliesNone);
  // 没有仓库条。
  await expect(butler.locator(".repos-bar")).toHaveCount(0);
  await expect(split.locator(".control-left")).toContainText(S.noButlerSessions);

  // 在 ~/.butler/workspaces/_butler 里打开，只挂全局记忆和 Butler 模式的 butler-sessions，不加 --add-dir。
  const newSession = split.locator(".control-left").getByRole("button", { name: `+ ${S.newButlerSession}`, exact: true });
  await newSession.click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const workspace = join(s.butlerHome, "workspaces", "_butler");
  await expect.poll(() => fakeLog(s)).toContain(`mcp=butler-workspace,butler-sessions cwd=${workspace} adddirs= guide=`);
  await expect(butler.locator(".session .place")).toHaveText([S.butlerSession]);
  await expect(split.locator(".control-left .terminal-wrap")).toHaveCount(1);

  // 全局只有一个在跑：再点一次切回同一个终端，不新开。
  await newSession.click();
  await expect(butler.locator(".terminal-wrap")).toHaveCount(1);
  expect(fakeLog(s).match(/ interactive new /g)).toHaveLength(1);
});

test("page tabs are always open and the last tab survives leaving and a reload", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  // 审计页的两个页签：总有一个选中、内容总在（没有收起），默认是「对外动作」。
  const openAudit = () => page.locator(".sidebar").getByRole("button", { name: S.audit, exact: true }).click();
  await openAudit();
  await expect(page.locator(".page-tabs-toggle")).toHaveCount(0);
  await expect(page.locator(".page-tabs-panel")).toHaveCount(1);
  await expect(pageTab(page, S.lay.auditTabs.external)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("external-audit")).toBeVisible();
  await openTab(page, S.lay.auditTabs.llm);
  // 再点一下当前页签不会收起。
  await pageTab(page, S.lay.auditTabs.llm).click();
  await expect(pageTab(page, S.lay.auditTabs.llm)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".page-tabs-panel")).toHaveCount(1);
  await expect(page.getByTestId("external-audit")).toHaveCount(0);
  // 离开再回来、重新加载：都还是「模型调用」。
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  await openAudit();
  await expect(pageTab(page, S.lay.auditTabs.llm)).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await openAudit();
  await expect(pageTab(page, S.lay.auditTabs.llm)).toHaveAttribute("aria-selected", "true");
});
