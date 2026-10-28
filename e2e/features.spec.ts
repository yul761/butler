import type { Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { S, STRINGS } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, terminalText, test, type Sandbox } from "./fixtures";

/** 在沙盒里建 shop/frontend、shop/backend 两个仓库，选上一层目录建 feature「checkout」（两个仓库默认都勾上）。 */
async function createCheckoutFeature(page: Page, s: Sandbox): Promise<void> {
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await page.getByRole("button", { name: `+ ${S.newFeature}`, exact: true }).click();
  await page.getByLabel(S.featureName, { exact: true }).fill("checkout");
  const dir = page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true });
  await dir.fill(shop);
  await dir.blur();
  await expect(page.getByText(S.subReposFound(2), { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "frontend", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "backend", exact: true })).toBeChecked();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
  await expect(page.locator(".feature-page .repos-bar .repo .name")).toHaveText(["backend", "frontend"]);
}

/** 在当前打开的 feature 页上建一个 ticket，只勾 repo 这一个仓库；建完停在 ticket 页。 */
async function newFeatureTicket(page: Page, key: string, repo: string): Promise<void> {
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill(key);
  for (const name of ["frontend", "backend"]) {
    const box = page.locator(".modal").getByRole("checkbox", { name, exact: true });
    if (name === repo) await box.check();
    else await box.uncheck();
  }
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 在当前显示的终端里输入一行并回车。 */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

/**
 * 设计文档 2026-10-26（feature）：选上一层目录建 feature（勾两个仓库）→ 在 feature 下建前端、后端两个 ticket，worktree 出现在工作区里
 * → feature 总控在工作区里打开 → 按 mcp 配置启动 butler-sessions，start_session 给前端 ticket 开子 session
 * → 子 session 退出后 handoff 报告 PR 已合并 → 前端 ticket 的 worktree 被自动清理。
 */
test("a feature over a parent directory: tickets' worktrees in its workspace, a coordinator, cleanup after merge", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const workspace = join(s.dir, "shop-features", "checkout");
  const feWorktree = join(workspace, "frontend-dms-1");
  const beWorktree = join(workspace, "backend-dms-2");
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 1. 新建 feature：选上一层目录，下一层的两个仓库默认都勾上。
  await createCheckoutFeature(page, s);

  // 2. feature 下建两个 ticket：前端一个、后端一个。worktree 放在工作区里。
  await newFeatureTicket(page, "DMS-1", "frontend");
  expect(existsSync(join(feWorktree, "README.md"))).toBe(true);
  await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();
  await newFeatureTicket(page, "DMS-2", "backend");
  expect(existsSync(join(beWorktree, "README.md"))).toBe(true);

  // 侧栏：feature 下面缩进列着它的两个 ticket，不在按状态分组的列表里。
  await expect(page.locator(".sidebar .feature-group .feature-tickets .ticket .key")).toHaveText(["DMS-1", "DMS-2"]);
  // 三角收起 feature 下的 ticket：正在看的 DMS-2 还留着；再点展开。
  const twisty = page.locator(".sidebar .feature-group .twisty");
  await twisty.click();
  await expect(page.locator(".sidebar .feature-group .feature-tickets .ticket .key")).toHaveText(["DMS-2"]);
  await twisty.click();
  await expect(page.locator(".sidebar .feature-group .feature-tickets .ticket .key")).toHaveText(["DMS-1", "DMS-2"]);

  // 3. feature 总控：在工作区里打开（worktree 都在里面，不需要 --add-dir），挂 feature 记忆和 feature 模式的 butler-sessions。
  await page.locator(".sidebar .ticket.feature").click();
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await expect.poll(fakeLog).toContain(`mcp=butler-workspace,butler-feature,butler-sessions cwd=${workspace} adddirs=\n`);
  const coordinatorId = /interactive new (\S+) mcp=butler-workspace,butler-feature,butler-sessions/.exec(fakeLog())![1];

  // 4. 按配置启动 butler-sessions，像 claude 一样经 stdio 调用：给 DMS-1（只有一个仓库，不用指定 repo）开子 session。
  const config = JSON.parse(readFileSync(join(s.butlerHome, "mcp", "features", "1.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const server = config.mcpServers["butler-sessions"];
  expect(server.env.BUTLER_FEATURE).toBe("1");
  const child = spawn(server.command, server.args, {
    env: { ...server.env, BUTLER_SESSION: coordinatorId, PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let started: { sessionId: string; ticket: string; repo: string };
  try {
    const replies = createInterface({ input: child.stdout });
    const next = () => new Promise<{ id: number; result: { content: { text: string }[]; isError?: boolean } }>((r) => replies.once("line", (l) => r(JSON.parse(l))));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })}\n`);
    await next();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_tickets", arguments: {} } })}\n`);
    const listed = JSON.parse((await next()).result.content[0].text) as { key: string }[];
    expect(listed.map((t) => t.key)).toEqual(["DMS-1", "DMS-2"]);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "start_session", arguments: { ticket: "DMS-1", task: "build-the-cart" } } })}\n`);
    const reply = await next();
    expect(reply.result.isError).toBeUndefined();
    started = JSON.parse(reply.result.content[0].text) as typeof started;
  } finally {
    child.kill();
  }
  expect(started).toMatchObject({ ticket: "DMS-1", repo: "frontend" });
  // 子 session 是 DMS-1 的普通 session：在它的 worktree 里，挂 ticket 记忆和 feature 记忆，没有 butler-sessions。
  await expect.poll(fakeLog).toContain(`interactive new ${started.sessionId} mcp=butler-memory,butler-workspace,butler-feature cwd=${feWorktree} adddirs=\n`);

  // 5. 在 DMS-1 里看到子 session，等任务提交后退出它（这个仓库自己的终端在跑时不会清理）。
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  const childButton = page.locator(".sessions-bar .session").filter({ has: page.locator(`[title="${S.spawnedByCoordinator}"]`) });
  await expect(childButton).toBeVisible();
  await childButton.click();
  // 等任务真的提交了（假 claude 回了“收到：”）再输入：粘贴之后、回车之前打的字会并进同一条消息。
  await expect.poll(() => terminalText(page)).toContain("收到：总控 session 交给你的任务：");
  await typeLine(page, "exit");
  await expect(page.locator(".terminal-wrap:visible .exited")).toBeVisible();

  // 6. handoff：假 claude 报告 PR 已合并 → worktree 被删掉（分支保留），仓库一行标着“已清理”。总控还开着也不拦。
  await page.getByRole("button", { name: S.runHandoff, exact: true }).click();
  await expect(page.locator(".repos-bar").getByText(S.worktreeRemoved, { exact: true })).toBeVisible();
  expect(existsSync(feWorktree)).toBe(false);
  expect(existsSync(beWorktree)).toBe(true);

  // 7. feature 总控说过话、退出之后可以从列表里隐藏，也能在 feature 页上恢复。
  await page.locator(".sidebar .ticket.feature").click();
  const coordinator = page.locator(".feature-page .sessions-bar .session-wrap");
  await coordinator.locator(".session").click();
  await typeLine(page, "plan the api");
  await expect.poll(() => terminalText(page)).toContain("收到：plan the api");
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(page.locator(".terminal-wrap:visible .exited")).toBeVisible();
  await coordinator.getByRole("button", { name: /^隐藏 / }).click();
  await expect(coordinator).toHaveCount(0);
  await page.locator(".feature-page").getByRole("button", { name: S.hiddenSessions(1), exact: true }).click();
  await page.locator(".feature-page .hidden-sessions").getByRole("button", { name: S.unhideSession, exact: true }).click();
  await expect(coordinator).toHaveCount(1);
});

/**
 * 设计文档 2026-10-28（feature 汇总）：DMS-1 在自己的 session 里 /handoff，留下一个带 PR 的 handoff；DMS-2 的 session 有新对话
 * → 总控里 /handoff 输出 butler-feature-handoff → feature 页显示汇总、卡住和下一步，来源是“总控 /handoff”
 * → 后台给有活动的 DMS-2 跑了 handoff（DMS-1 没有新活动，不跑），ticket 表里两个 ticket 都有 PR 标签
 * → “立即更新”生成新的汇总，来源变成“手动更新” → 切到英文后再更新一次，界面和汇总都是英文。
 * 设了 BUTLER_E2E_SHOTS_DIR 时把中英文的 feature 页各截一张图存到那里（CI 不设）。
 */
test("feature summary: the coordinator's /handoff, child tickets' handoffs and the update button", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const workspace = join(s.dir, "shop-features", "checkout");
  const feWorktree = join(workspace, "frontend-dms-1");
  const beWorktree = join(workspace, "backend-dms-2");
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const sessionIn = (cwd: string) => new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${escapeRe(cwd)} `).exec(fakeLog())?.[1];
  const headlessLines = () => fakeLog().split("\n").filter((l) => / headless .*--json-schema/.test(l));
  const shots = process.env.BUTLER_E2E_SHOTS_DIR;
  const { app, page } = await launch(s);
  await completeWizard(page, s);

  await createCheckoutFeature(page, s);
  await newFeatureTicket(page, "DMS-1", "frontend");
  await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();
  await newFeatureTicket(page, "DMS-2", "backend");
  const ticketPage = (key: string) => page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: key }).click();
  const featurePage = () => page.locator(".sidebar .ticket.feature").click();

  // 1. DMS-1：在自己的 session 里 /handoff（ticket 的 butler-handoff 代码块，PR 还开着、已 approve）。
  await ticketPage("DMS-1");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, "/handoff");
  await expect.poll(() => terminalText(page)).toContain("butler-handoff");

  // 2. DMS-2：session 里有新的对话（之后算“有活动”），还没有 handoff。
  await ticketPage("DMS-2");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, "build the order api");
  await expect.poll(() => terminalText(page)).toContain("收到：build the order api");
  const dms2Session = sessionIn(beWorktree)!;
  expect(dms2Session).toBeTruthy();

  // 还没有汇总；ticket 表里 DMS-1 已有 PR（只有一个 PR，标签不带仓库名），DMS-2 还没有。
  await featurePage();
  const progress = page.locator(".feature-page .feature-progress");
  const row = (key: string) => page.locator(".feature-page .ticket-table tr").filter({ hasText: key });
  await expect(progress.getByText(S.featureSummaryNone, { exact: true })).toBeVisible();
  await expect(row("DMS-1").locator(".pill")).toHaveText([`#12 ${S.prPill.approved}`]);
  await expect(row("DMS-2").locator(".pill")).toHaveText([S.noPr]);
  // ticket 表能收起，离开再回来还是收起的；再展开。
  const ticketsToggle = page.locator(".feature-page .section-toggle");
  await ticketsToggle.click();
  await expect(page.locator(".feature-page .ticket-table")).toHaveCount(0);
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  await featurePage();
  await expect(page.locator(".feature-page .ticket-table")).toHaveCount(0);
  await ticketsToggle.click();
  await expect(row("DMS-1")).toBeVisible();

  // 3. 总控里 /handoff：输出 butler-feature-handoff，存成 feature 汇总。
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const coordinatorId = sessionIn(workspace)!;
  expect(coordinatorId).toBeTruthy();
  await typeLine(page, "/handoff");
  const summary = progress.locator(".feature-summary");
  await expect(summary.locator("p").first()).toHaveText("结账页前端（DMS-1）已提 PR 等合并；后端下单接口（DMS-2）还在写，两边还没联调。");
  await expect(summary.locator(".blocker")).toHaveText([S.labelled(S.featureBlocked, "DMS-2 等支付网关的测试账号")]);
  await expect(summary.getByText(S.nextSteps, { exact: true })).toBeVisible();
  // 小写的 dms-2 规范成了本 feature 的 DMS-2，能点。
  await expect(summary.locator("li")).toHaveText(["DMS-2 写完下单接口", "两边合并后联调结账流程"]);
  await expect(summary.locator("li").first().getByRole("button", { name: "DMS-2", exact: true })).toBeVisible();
  await expect(progress.locator(".summary-meta .muted").first()).toContainText(S.featureSummaryTrigger.command);

  // 4. /handoff 之后后台给有活动的 DMS-2 跑了 handoff（fork 它的 session）：PR 已合并。DMS-1 没有新活动，不跑。
  //    整个 feature 有两个 PR 了，标签带上仓库名。
  await expect(row("DMS-2").locator(".pill")).toHaveText([`backend#7 ${S.prPill.merged}`]);
  await expect(row("DMS-1").locator(".pill")).toHaveText([`frontend#12 ${S.prPill.approved}`]);
  expect(headlessLines()).toHaveLength(1);
  expect(headlessLines()[0]).toContain(`--resume ${dms2Session} --fork-session`);
  expect(headlessLines()[0]).toContain(`cwd=${beWorktree}`);
  expect(fakeLog()).not.toMatch(new RegExp(` headless .*cwd=${escapeRe(feWorktree)}`));

  // 5. “立即更新”：子 ticket 都没有新活动，直接 fork 总控生成汇总；来源变成“手动更新”。
  await progress.getByRole("button", { name: S.runFeatureSummary, exact: true }).click();
  await expect(progress.getByText(S.featureSummaryStored, { exact: true })).toBeVisible();
  await expect(summary.locator("p").first()).toHaveText("后端下单接口（DMS-2）已合并；前端结账页（DMS-1）的 PR 已 approve，合并后就能联调。");
  await expect(summary.locator(".blocker")).toHaveText([S.labelled(S.featureBlocked, "DMS-1 等支付表单的设计 review")]);
  await expect(summary.locator("li")).toHaveText(["DMS-1 合并结账页的 PR", "在 staging 联调结账流程"]);
  await expect(progress.locator(".summary-meta .muted").first()).toContainText(S.featureSummaryTrigger.manual);
  expect(headlessLines()).toHaveLength(2);
  expect(headlessLines()[1]).toContain(`--resume ${coordinatorId} --fork-session`);
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, "feature-page-zh.png") });
  }

  // 6. 切到英文（同 language.spec：不设 BUTLER_LANG 重启，在设置里选 English，窗口重新加载）后再更新一次。
  await app.close();
  s.lang = null;
  const en = (await launch(s)).page;
  const E = STRINGS.en;
  await en.locator(".sidebar button.nav").filter({ hasText: new RegExp(`^(${STRINGS.zh.settings}|${E.settings})$`) }).click();
  await en.locator(".language-picker select").selectOption("en");
  await expect(en.locator(".sidebar button.nav").filter({ hasText: new RegExp(`^${E.settings}$`) })).toBeVisible();
  await en.locator(".sidebar .ticket.feature").click();
  const enProgress = en.locator(".feature-page .feature-progress");
  await expect(enProgress.getByRole("heading", { name: E.featureProgress, exact: true })).toBeVisible();
  await enProgress.getByRole("button", { name: E.runFeatureSummary, exact: true }).click();
  await expect(enProgress.getByText(E.featureSummaryStored, { exact: true })).toBeVisible();
  await expect(enProgress.locator(".feature-summary p").first()).toContainText("The backend order API (DMS-2) is merged");
  await expect(enProgress.locator(".blocker")).toHaveText([E.labelled(E.featureBlocked, "DMS-1 is waiting for the design review of the payment form")]);
  await expect(enProgress.locator(".summary-meta .muted").first()).toContainText(E.featureSummaryTrigger.manual);
  await expect(en.locator(".feature-page .ticket-table tr").filter({ hasText: "DMS-2" }).locator(".pill")).toHaveText([`backend#7 ${E.prPill.merged}`]);
  if (shots) await en.screenshot({ path: join(shots, "feature-page-en.png") });
});
