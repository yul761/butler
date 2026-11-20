import type { Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, openSettingsGroup, type Sandbox, terminalText, test } from "./fixtures";

/**
 * 模型路由（3.0）的设置页和交互 session 撞限后换模型：
 * 没配置时是旧行为；在设置页登记两个模型，任务表显示第一个模型；
 * Butler 总控 session 撞限后，session 行上出现「换到 X 继续」，点了用 --resume + --model 重开。
 */


async function openRouting(page: Page): Promise<void> {
  await openSettingsGroup(page, "routing");
  await expect(page.getByTestId("routing-settings")).toBeVisible();
}

async function addModel(page: Page, name: string, tier: "high" | "mid" | "low"): Promise<void> {
  await page.getByTestId("new-model-name").fill(name);
  await page.getByTestId("new-model-tier").selectOption(tier);
  await page.getByRole("button", { name: S.rt.addModel, exact: true }).click();
  await expect(page.getByTestId("registry-row").filter({ hasText: name })).toHaveCount(1);
}

/** 假 claude 每次交互启动记的模型（interactive-model 行），按顺序；没带 --model 是 "-"。 */
function interactiveModels(s: Sandbox): string[] {
  if (!existsSync(s.fakeLog)) return [];
  return readFileSync(s.fakeLog, "utf8").split("\n").flatMap((l) => {
    const m = / interactive-model \S+ (\S+)$/.exec(l);
    return m ? [m[1]!] : [];
  });
}

test("model routing: register models in settings, then switch a limited session to the next model", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200" };
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 1. 没配置：说明是旧行为，任务表里需要你的判断还是 haiku。
  await openRouting(page);
  await expect(page.getByTestId("routing-status")).toHaveText(S.rt.unconfigured);
  await expect(page.getByTestId("task-needs_you")).toContainText("haiku");

  // 2. 登记两个模型：高一档、中一档。配置之后任务表按档位选模型，需要你的判断（低档，最低中档以下）落到能用的那个。
  await addModel(page, "claude-fake-high", "high");
  await addModel(page, "claude-fake-mid", "mid");
  await expect(page.getByTestId("routing-status")).toHaveText(S.rt.configured);
  await expect(page.getByTestId("task-pr_brief")).toContainText("claude-fake-mid");
  await expect(page.getByTestId("health-pill").first()).toHaveText(S.rt.health.ok);

  // 3. 开一个 Butler 总控 session（没指定模型：不带 --model），让它撞限。
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  const butler = page.locator(".butler-page");
  await butler.getByRole("button", { name: `+ ${S.newButlerSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  expect(interactiveModels(s)).toEqual(["-"]);
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("/fake-limit You've hit your limit · resets 3pm (UTC)");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("hit your limit");

  // 4. session 行上：撞限提示和「换到 claude-fake-high 继续」。点了之后用 --resume + --model 重开，提示消失。
  const hint = butler.getByTestId("session-limit");
  await expect(hint).toBeVisible();
  const sw = hint.getByTestId("session-switch");
  await expect(sw).toHaveText(S.rt.switchNext("claude-fake-high"));
  await sw.click();
  await expect.poll(() => interactiveModels(s)).toEqual(["-", "claude-fake-high"]);
  await expect.poll(() => readFileSync(s.fakeLog, "utf8")).toMatch(/interactive resume /);
  await expect(hint).toHaveCount(0);

  // 5. 设置页的事件记录里有这次切换。
  await openRouting(page);
  await expect(page.getByTestId("routing-events")).toContainText(S.rt.event.session_switch);
});
