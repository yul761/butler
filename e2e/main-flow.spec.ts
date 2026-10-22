import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { S, STATUS_LABEL } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test } from "./fixtures";

/**
 * 设计文档 11 节的主流程（计划 5 任务 9）：真实的主进程、preload、React 界面、node-pty、butler-hook（经 shell 执行）、
 * HookInbox、HandoffRunner、StateCore 和简报引擎；只有 claude 是假的。个人 LLM 是关的：简报只断言确定性的部分。
 * 定位都用精确匹配或 role（Ruling P5-PF4）：S.memoryHandoff 是 S.memoryHint 的子串，S.home、S.regenerate、
 * S.runHandoff、S.newSession、S.newTicket 也都出现在别的提示文字里。
 */
test("new ticket → session → hook → handoff → memory → morning brief → open with prefill", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page, console: messages } = await launch(s);
  const mainLog = join(s.butlerHome, "logs", "main.log");
  try {
    await completeWizard(page, s);

    // 1. 新建 ticket（worktree 模式，默认）。
    await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
    await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-1");
    // 这个 label 里还包着“选择…”按钮，输入框的可访问名是两段文字连起来。
    await page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true }).fill(s.repo);
    await page.getByRole("button", { name: S.create, exact: true }).click();
    await expect(page.getByRole("heading", { name: "E2E-1", exact: true })).toBeVisible();

    // 2. 新 session：假 claude 在 PTY（xterm，生产 CSP 下）里启动，--mcp-config 带着两个记忆 server（路径里有空格）。
    await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
    await expect.poll(() => terminalText(page)).toContain("fake claude ready");
    await expect.poll(() => terminalText(page)).toContain("mcp: butler-memory, butler-workspace");

    // 3. 输入一句话：UserPromptSubmit / Stop hook 经 shell 执行 butler-hook → inbox → 侧栏“等你输入”。
    await page.locator(".terminal-wrap:visible .xterm").click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Enter");
    await expect.poll(() => terminalText(page)).toContain("收到：hello");
    await expect(page.locator(".sidebar .ticket .badge")).toBeVisible();
    await expect(page.locator(".sidebar .ticket .badge")).toHaveAttribute("title", S.waiting);

    // 4. 立即 handoff（假 claude 的 -p 模式，不挂记忆）：合并后任务入库，ticket 变成“已合并·待收尾”。
    await page.getByRole("button", { name: S.runHandoff, exact: true }).click();
    await page.getByRole("button", { name: S.followupsTab(1), exact: true }).click();
    await expect(page.locator(".followup .text").getByText("改 staging 配置", { exact: true })).toBeVisible();
    const pending = page.locator(".sidebar section").filter({ has: page.getByRole("heading", { name: STATUS_LABEL.merged_pending_followup, exact: true }) });
    await expect(pending.locator(".ticket .key")).toHaveText(["E2E-1"]);

    // 5. 记忆标签：handoff 入库后同步进 StateCore，标签收到 memory:changed 后重读。决策、follow-up 和交接都在。
    await page.getByRole("button", { name: S.memoryTab, exact: true }).click();
    const decision = page.locator(".memory-item").filter({ has: page.getByText("用 PostgreSQL", { exact: true }) });
    await expect(decision).toBeVisible();
    await expect(page.locator(".memory-item .text").getByText("改 staging 配置（配置，合并后）", { exact: true })).toBeVisible();
    await expect(page.locator(".memory-handoff").getByText(S.memoryHandoff, { exact: true })).toBeVisible();
    await expect(page.locator(".memory-handoff pre")).toContainText("接口写完");

    // 5b. “来历”：决策的版本链（Ruling P5-PF7(c)）。只写过一次，所以只有一个“当前”版本。
    await decision.getByRole("button", { name: S.memoryWhy, exact: true }).click();
    const chain = decision.locator(".why-chain");
    await expect(chain.getByText(S.memoryWhyTitle, { exact: true })).toBeVisible();
    await expect(chain.locator("li")).toHaveCount(1);
    await expect(chain.locator("li.why-current")).toContainText("用 PostgreSQL");
    await expect(chain.locator("li.why-current")).toContainText(S.whyState.current);

    // 6. 早间简报：“先做”里有这条合并后任务；点“打开”回到同一个终端并预填提示（不回车）。
    await page.getByRole("button", { name: S.home, exact: true }).click();
    await page.getByRole("button", { name: S.regenerate, exact: true }).click();
    const first = page.locator(".brief-section").filter({ has: page.getByRole("heading", { name: S.briefSections.first, exact: true }) });
    const item = first.locator(".brief-item").filter({ hasText: "合并后任务：改 staging 配置" });
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: S.itemActions.open, exact: true }).click();
    await expect.poll(() => terminalText(page)).toContain("继续 follow-up：改 staging 配置（来自 E2E-1）");
    await expect(page.locator(".terminal-wrap")).toHaveCount(1);
    expect(await terminalText(page)).not.toContain("收到：继续");

    // 7. CSP 没有拦下任何东西（任务 6 的运行时检查，xterm 在其中）：渲染进程的控制台，以及主进程的日志——
    //    附上 console 监听之前（页面加载时）的违规只在日志里。日志第一次写入时才创建，没有这个文件就是什么都没记。
    expect(messages.filter((m) => /Content Security Policy/i.test(m))).toEqual([]);
    expect(existsSync(mainLog) ? readFileSync(mainLog, "utf8") : "").not.toMatch(/CSP violation/i);
  } catch (e) {
    // 失败时把假 claude 的记录和 Butler 的日志打出来，CI 里直接能看（沙盒也会留下）。
    for (const f of [s.fakeLog, mainLog]) {
      if (existsSync(f)) console.log(`--- ${f}\n${readFileSync(f, "utf8")}`);
    }
    throw e;
  }
});
