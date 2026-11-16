import type { Locator } from "@playwright/test";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, pageTab, terminalText, test } from "./fixtures";

/**
 * PR 进度（设计文档 2026-11-15 第 1 部分）：假 claude 里输入 /fake-skill，走真实的路径：
 * 假 claude → matcher 为 Skill 的 PostToolUse hook → butler-hook → HookInbox → stageEventFromHook → PrStagesService → ticket 页的「PR 进度」tab。
 */
test("a skill call in a session moves the design step to active; tab and timeline collapse and stay collapsed", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);

  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-1");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();

  const tab = pageTab(page, S.prStagesTab);
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const design = page.locator(".pr-stages .pr-cell").filter({ hasText: S.prStage.design });
  await expect(design).toHaveClass(/pr-todo/);

  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("/fake-skill superpowers:brainstorming");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("skill superpowers:brainstorming");

  // 设计那一格进行中（还没有 PR，也没有第一次提交）。
  await expect(design).toHaveClass(/pr-active/);

  // 时间线：收起后消失；刷新页面后仍然是收起的。
  const timeline = page.locator(".pr-timeline");
  await expect(timeline).toBeVisible();
  await page.getByRole("button", { name: S.prTimelineHide, exact: true }).click();
  await expect(timeline).toHaveCount(0);
  await page.reload();
  await page.locator(".sidebar .ticket .key").getByText("E2E-1", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: S.prTimelineShow, exact: true })).toBeVisible();
  await expect(page.locator(".pr-timeline")).toHaveCount(0);

  // 点 tab 收起整个面板；刷新后仍然是收起的。
  await tab.click();
  await expect(page.locator(".pr-stages")).toHaveCount(0);
  await page.reload();
  await page.locator(".sidebar .ticket .key").getByText("E2E-1", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();
  await expect(pageTab(page, S.prStagesTab)).toHaveAttribute("aria-selected", "false");
  await expect(page.locator(".pr-stages")).toHaveCount(0);
});

test("an expanded feature in the epic's stages tab opens its ticket (mouse and keyboard)", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const shop = join(s.dir, "shop");
  const { page } = await launch(s);
  await completeWizard(page, s);
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));

  const dialog = async (open: Locator, label: string, name: string) => {
    await open.click();
    await page.getByLabel(label, { exact: true }).fill(name);
    const box = page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true });
    await box.fill(shop);
    await box.blur();
    await expect(page.getByText(S.subReposFound(2), { exact: true })).toBeVisible();
    await page.getByRole("button", { name: S.create, exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  };
  await dialog(page.locator(".sidebar").getByRole("button", { name: `+ ${S.newEpic}`, exact: true }), S.epicName, "shop-epic");
  await dialog(page.locator(".epic-page .page-tabs-bar").getByRole("button", { name: `+ ${S.newFeature}`, exact: true }), S.featureName, "pay");

  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("EP-1");
  await page.locator(".modal").getByRole("checkbox", { name: "frontend", exact: true }).check();
  await page.locator(".modal").getByRole("checkbox", { name: "backend", exact: true }).uncheck();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "EP-1", exact: true })).toBeVisible();

  const openFromEpic = async (activate: (chip: Locator) => Promise<void>) => {
    await page.locator(".sidebar .epic-group > .feature-row .ticket").click();
    await expect(page.getByRole("heading", { name: "shop-epic", exact: true })).toBeVisible();
    const tab = pageTab(page, S.prStagesTab);
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await page.locator(".pr-epic").getByRole("button", { name: "pay", exact: true }).click();
    await activate(page.locator(".pr-table").getByRole("button", { name: "EP-1", exact: true }));
    await expect(page.getByRole("heading", { name: "EP-1", exact: true })).toBeVisible();
  };
  await openFromEpic((chip) => chip.click());
  await openFromEpic(async (chip) => {
    await chip.focus();
    await page.keyboard.press("Enter");
  });
});
