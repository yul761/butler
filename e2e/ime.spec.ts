import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test } from "./fixtures";

/**
 * 用户反馈（2026-11-01）：输入拼音时拼音框往前窜一格挡住字；在 session 右边缘打字时拼音把整个 UI 往右撑开。
 * 用 CDP 的 Input.imeSetComposition 模拟输入法（真实拼音输入法没有测过）。
 */
test("the pinyin box stays on the cursor and inside the terminal", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("IME-1");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "IME-1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();

  const cdp = await page.context().newCDPSession(page);
  const compose = (text: string) => cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  const wrap = page.locator(".terminal-wrap:visible");
  const view = wrap.locator(".composition-view");
  // xterm 把隐藏的输入框放在光标上；光标闪烁或折行时 .xterm-cursor 可能不在，量右边缘用输入框。
  const cursorLeft = () => wrap.locator(".xterm-cursor").evaluate((e) => e.getBoundingClientRect().left);
  const caretLeft = () => wrap.locator(".xterm-helper-textarea").evaluate((e) => e.getBoundingClientRect().left);

  // 1. 全角标点之后，拼音框的左边和光标对齐（以前被量窄的标点让它盖住前面的字）。
  const typed = "你好，世界。（测试）";
  await page.keyboard.insertText(typed);
  await expect.poll(() => terminalText(page)).toContain(typed);
  await compose("ni");
  await expect(view).toHaveClass(/active/);
  const gap = Math.abs((await view.evaluate((e) => e.getBoundingClientRect().left)) - (await cursorLeft()));
  expect(gap).toBeLessThanOrEqual(1);
  await cdp.send("Input.insertText", { text: "" });
  await compose("");

  // 2. 光标靠近右边缘、输入长拼音：页面不横向滚动，UI 不动，拼音框不超出终端右边。
  const wrapRight = () => wrap.evaluate((e) => e.getBoundingClientRect().right);
  // 先大步走，离右边 120px 内改成一格一格走，免得一步跨过去折到下一行。
  for (let i = 0; i < 600; i++) {
    const room = (await wrapRight()) - (await caretLeft());
    if (room <= 30) break;
    await page.keyboard.insertText(room > 120 ? "a".repeat(8) : "a");
  }
  expect((await wrapRight()) - (await caretLeft())).toBeLessThanOrEqual(30);
  await compose("zhong'guo'ren'min'gong'he'guo'wan'sui'wan'sui'wan'wan'sui");
  await expect(view).toHaveClass(/active/);
  // 移位在下一帧生效，等它稳定。
  await expect.poll(async () => (await view.evaluate((e) => e.getBoundingClientRect().right)) <= (await wrapRight()) + 0.5).toBe(true);
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
  expect(await page.locator(".app").evaluate((e) => e.getBoundingClientRect().left)).toBe(0);

  // 3. 提交后 transform 被清掉。
  await cdp.send("Input.insertText", { text: "中国" });
  await compose("");
  await expect.poll(() => view.evaluate((e) => (e as HTMLElement).style.transform)).toBe("");
});
