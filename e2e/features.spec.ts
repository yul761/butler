import type { ElectronApplication, Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
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
    // 总控直接建 ticket：DMS-3 用 backend，马上出现在侧栏的 feature 下面。
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_ticket", arguments: { ticket: "dms-3", title: "Refunds", repos: ["backend"] } } })}\n`);
    const created = await next();
    expect(created.result.isError).toBeUndefined();
    expect(JSON.parse(created.result.content[0].text)).toMatchObject({ key: "DMS-3", repos: [{ name: "backend", dir: join(workspace, "backend-dms-3") }] });
  } finally {
    child.kill();
  }
  expect(started).toMatchObject({ ticket: "DMS-1", repo: "frontend" });
  await expect(page.locator(".sidebar .feature-group .feature-tickets .ticket .key")).toHaveText(["DMS-1", "DMS-2", "DMS-3"]);
  expect(existsSync(join(workspace, "backend-dms-3"))).toBe(true);
  // 子 session 是 DMS-1 的普通 session：在它的 worktree 里，挂 ticket 记忆和 feature 记忆，没有 butler-sessions。
  await expect.poll(fakeLog).toContain(`interactive new ${started.sessionId} mcp=butler-memory,butler-workspace,butler-feature cwd=${feWorktree} adddirs=\n`);

  // 5. 在 DMS-1 里看到子 session，等任务提交后用按钮旁的 × 结束它（点两次；这个仓库自己的终端在跑时不会清理）。
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  const childWrap = page.locator(".sessions-bar .session-wrap").filter({ has: page.locator(`[title="${S.spawnedByCoordinator}"]`) });
  const childButton = childWrap.locator(".session");
  await expect(childButton).toBeVisible();
  await childButton.click();
  await expect.poll(() => terminalText(page)).toContain("收到：总控 session 交给你的任务：");
  const end = childWrap.getByRole("button", { name: /^结束 / });
  await end.click();
  await expect(end).toHaveText(S.endSessionConfirm);
  await end.click();
  // 终端面板关掉，按钮变回“打开”，旁边的 × 变成隐藏。
  await expect(childButton.locator(".action")).toHaveText(S.open);
  await expect(page.locator(".terminal-wrap")).toHaveCount(0);
  await expect(childWrap.getByRole("button", { name: /^隐藏 / })).toBeVisible();

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
  await expect.poll(() => terminalText(page)).toContain("next_steps");

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
  const ticketsToggle = page.locator(".feature-page .feature-tickets .section-toggle");
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

  // 整体进度能收起：只留一行开头和卡住的条数，离开再回来还是收起的；终端至少占窗口一半高。再展开。
  const progressToggle = progress.locator(".section-toggle");
  await progressToggle.click();
  await expect(summary).toHaveCount(0);
  await expect(progress.locator(".preview")).toHaveText("后端下单接口（DMS-2）已合并；前端结账页（DMS-1）的 PR 已 approve，合并后就能联调。");
  await expect(progress.locator("h3 .blocker")).toHaveText(S.featureBlockedCount(1));
  await ticketPage("DMS-1");
  await featurePage();
  await expect(summary).toHaveCount(0);
  const heights = await page.evaluate(() => ({ terminals: document.querySelector(".feature-page .terminals")!.getBoundingClientRect().height, window: window.innerHeight }));
  expect(heights.terminals).toBeGreaterThanOrEqual(heights.window / 2 - 1);
  await progressToggle.click();
  await expect(summary.locator("p").first()).toBeVisible();
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
  await expect(enProgress.locator(".section-toggle")).toContainText(E.featureProgress);
  await enProgress.getByRole("button", { name: E.runFeatureSummary, exact: true }).click();
  await expect(enProgress.getByText(E.featureSummaryStored, { exact: true })).toBeVisible();
  await expect(enProgress.locator(".feature-summary p").first()).toContainText("The backend order API (DMS-2) is merged");
  await expect(enProgress.locator(".blocker")).toHaveText([E.labelled(E.featureBlocked, "DMS-1 is waiting for the design review of the payment form")]);
  await expect(enProgress.locator(".summary-meta .muted").first()).toContainText(E.featureSummaryTrigger.manual);
  await expect(en.locator(".feature-page .ticket-table tr").filter({ hasText: "DMS-2" }).locator(".pill")).toHaveText([`backend#7 ${E.prPill.merged}`]);
  if (shots) await en.screenshot({ path: join(shots, "feature-page-en.png") });
});

/** 假 claude 跑的命令：够长，状态列放不下；第一个词让它归类成“跑测试”。 */
const LONG_COMMAND = "pnpm test --filter @acme/checkout-frontend --run --reporter=verbose";
/** 假 claude 写进输出文件的内容。 */
const COMMAND_OUTPUT = Array.from({ length: 8 }, (_, i) => `step ${i + 1} of 8`);
const VERDICT_REASON = { zh: "测试进程在等一个不会来的信号", en: "The test process is waiting for a signal that will not come" };
const VERDICT_ACTION = { zh: "确认测试进程没有在动，再决定要不要杀掉重跑", en: "Check that the test process is idle, then decide whether to kill and rerun it" };
const STUCK_CHECK_MS = 1000;

/** main 进程里记下的通知。 */
type Captured = { notifications: Electron.Notification[] };

/** 接过系统通知：不在桌面上弹出来，测试自己“点”。必须在 session 卡住之前调用。 */
async function captureNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const shown: Electron.Notification[] = [];
    (globalThis as unknown as Captured).notifications = shown;
    Notification.isSupported = () => true;
    Notification.prototype.show = function show(this: Electron.Notification) {
      shown.push(this);
    };
  });
}

const notifications = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as Captured).notifications.map((n) => ({ title: n.title, body: n.body })));

const clickNotification = (app: ElectronApplication, index: number) =>
  app.evaluate((_, i) => void (globalThis as unknown as Captured).notifications[i].emit("click"), index);

const hideWindow = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
const windowVisible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
const resizeWindow = (app: ElectronApplication, width: number, height: number) =>
  app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height });

/** 终端区至少占窗口一半高，而且整个在窗口里。 */
async function expectTerminalsKeepHalf(page: Page): Promise<void> {
  const m = await page.evaluate(() => {
    const r = document.querySelector(".feature-page .terminals")!.getBoundingClientRect();
    return { height: r.height, bottom: r.bottom, window: window.innerHeight };
  });
  expect(m.height, JSON.stringify(m)).toBeGreaterThanOrEqual(m.window * 0.5);
  expect(m.bottom, JSON.stringify(m)).toBeLessThanOrEqual(m.window);
}

/** 直接读 Butler 的数据库（只读）：有些事界面上看不出来。 */
function dbRows<T>(s: Sandbox, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(join(s.butlerHome, "app.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/**
 * 设计文档 2026-10-31（ticket 实时状态）：假 claude 写 transcript 和真实位置的 tasks/<id>.output → feature 页显示活动
 * → 本地检查（真的 ps、真的 pty pid）判定可疑，真的 headless 判断 stuck: true → 红点、通知 → 面板展开、缩回、再打开内容还在，
 * 终端区至少占一半高，终端能输入 → 忽略 → 恢复活动红点消失、再次卡住 → 开修复 session，收到四条规则，不算总控
 * → 点通知展开面板，feature 页不重新挂载，当前终端不变 → 重启后换成英文再卡住一次。
 * 设了 BUTLER_E2E_SHOTS_DIR 时截图存到那里，文件名 live-status-*.png（CI 不设）。
 */
test("live status and stuck handling on the feature page", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "Windows has no tasks directory or CPU reading in this version: only the command and duration show");
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200", BUTLER_STUCK_CHECK_MS: String(STUCK_CHECK_MS) };
  const workspace = join(s.dir, "shop-features", "checkout");
  const worktree = join(workspace, "frontend-dms-1");
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const sessionIn = (cwd: string) => new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${escapeRe(cwd)} `).exec(fakeLog())?.[1];
  const judgePrompts = () => [...fakeLog().matchAll(/ judge prompt (.+)/g)].map((m) => JSON.parse(m[1]) as string);
  const shots = process.env.BUTLER_E2E_SHOTS_DIR;
  const shot = async (target: Page, name: string, colorScheme: "light" | "dark") => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    await target.emulateMedia({ colorScheme });
    await target.screenshot({ path: join(shots, name) });
  };

  const { app, page } = await launch(s);
  // 渲染进程的异常会让整页变白：一个都不能有。
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await captureNotifications(app);
  await completeWizard(page, s);
  await createCheckoutFeature(page, s);
  await newFeatureTicket(page, "DMS-1", "frontend");
  await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();
  await newFeatureTicket(page, "DMS-2", "backend");
  const ticketPage = (key: string) => page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: key }).click();
  const featurePage = () => page.locator(".sidebar .ticket.feature").click();
  const onFeaturePage = () => expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
  const onTicketPage = (key: string) => expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
  const row = (key: string) => page.locator(".feature-page .ticket-table tr").filter({ hasText: key });
  const overview = page.locator(".feature-page .feature-overview");
  const overviewScroll = () => overview.evaluate((e) => e.scrollTop);
  const scrollOverviewToTop = () => overview.evaluate((e) => void (e.scrollTop = 0));

  // 1. 总控开着，并且有一份汇总：概览区的内容比较多，修复 session 的任务里也要写上总控的名字。
  await featurePage();
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const coordinatorId = sessionIn(workspace)!;
  expect(coordinatorId).toBeTruthy();
  await typeLine(page, "/handoff");
  await expect(page.locator(".feature-summary p").first()).toBeVisible();

  // 2. DMS-1 的 session 开始跑一个命令，这一轮不结束。
  await ticketPage("DMS-1");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const stuckId = sessionIn(worktree)!;
  expect(stuckId).toBeTruthy();
  await typeLine(page, `/fake-bash ${LONG_COMMAND}`);
  await expect.poll(fakeLog).toContain(" task output ");
  const outputFile = /task output (.+)/.exec(fakeLog())![1];

  // 3. 状态列显示这个 session 此刻在干什么；没有运行中 session 的 DMS-2 还是原来的 ticket 状态。
  await featurePage();
  const activity = row("DMS-1").locator(".status .activity");
  await expect(activity.locator(".main")).toHaveText(S.activity.test);
  await expect(activity.locator("small")).toContainText(LONG_COMMAND.slice(0, 40));
  await expect(row("DMS-2").locator(".status")).not.toHaveText("");
  await expect(row("DMS-2").locator(".status .activity")).toHaveCount(0);

  // 4. 两次检查没变化 → 真的 headless 判断 stuck: true → 红点、淡红底色和一条通知。点红点之前面板是关着的。
  const dot = row("DMS-1").getByRole("button", { name: `DMS-1 ${S.stuckDot}`, exact: true });
  const panel = page.locator(".stuck-panel");
  await expect(dot).toBeVisible();
  await expect(row("DMS-1")).toHaveClass(/stuck/);
  await expect(panel).toHaveCount(0);
  await expect.poll(() => notifications(app)).toHaveLength(1);
  const [shown] = await notifications(app);
  expect(shown.title).toContain("DMS-1");
  expect(shown.body).toContain(VERDICT_REASON.zh);

  // 判断用的 prompt 证明这些都是真的读到的：transcript、tasks 目录的输出文件、ps 读到的子进程 CPU（读不到时写的是“未知”）。
  expect(judgePrompts()).toHaveLength(1);
  expect(judgePrompts()[0]).toContain(LONG_COMMAND.slice(0, 40));
  expect(judgePrompts()[0]).toContain(COMMAND_OUTPUT.join("\n"));
  expect(judgePrompts()[0]).toContain("子进程最近几分钟几乎没有用 CPU。");
  // headless 自己的 session 不进“未认领”。
  expect(dbRows(s, "SELECT cwd, dismissed FROM sessions WHERE id LIKE 'judge-%'")).toEqual([{ cwd: worktree, dismissed: 1 }]);

  // “已 N 分钟没有新输出”完整显示，不会被截掉；鼠标放上去也能看到全文。
  const sub = activity.locator("small");
  await expect(sub).toContainText(S.activitySilent(S.durationMinutes(1)));
  await expect(sub).toHaveAttribute("title", (await sub.textContent())!);
  expect(await sub.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  if (shots) await row("DMS-1").screenshot({ path: join(shots, "live-status-row.png") });

  // 5. 点红点展开面板，不进 ticket 页。概览区内容多时自己滚到面板，按钮看得到。面板只显示最后 6 行。
  const fix = panel.getByRole("button", { name: S.stuckFix, exact: true });
  await dot.click();
  await expect(fix).toBeInViewport();
  await onFeaturePage();
  await expect(panel).toContainText(VERDICT_REASON.zh);
  await expect(panel).toContainText(VERDICT_ACTION.zh);
  await expect(panel.locator(".stuck-log")).toHaveText(COMMAND_OUTPUT.slice(-6).join("\n"));
  await shot(page, "live-status-zh.png", "light");
  await shot(page, "live-status-zh-dark.png", "dark");

  // 6. 缩回再打开，内容还在。
  const content = await panel.innerText();
  await dot.click();
  await expect(panel).toHaveCount(0);
  await onFeaturePage();
  await dot.click();
  await expect(fix).toBeInViewport();
  expect(await panel.innerText()).toBe(content);

  // 面板里的“收起”：红点可能已经滚出视野，不用先滚回去。收起后这一行又看得到，面板记成关着。
  await panel.getByRole("button", { name: S.collapse, exact: true }).click();
  await expect(panel).toHaveCount(0);
  await onFeaturePage();
  await expect(dot).toBeInViewport();
  await expect(dot).toHaveAttribute("aria-expanded", "false");
  await dot.click();
  await expect(fix).toBeInViewport();

  // 7. 面板开着：终端区至少占窗口一半高，窗口缩到最小也一样，这时概览区自己滚动，面板的按钮还够得着。
  await expectTerminalsKeepHalf(page);
  await resizeWindow(app, 900, 600);
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(600);
  await expectTerminalsKeepHalf(page);
  // 窗口矮、面板比概览区还高时，点红点后按钮（含“收起”）也要都看得到，不靠测试自己去滚。
  const collapse = panel.getByRole("button", { name: S.collapse, exact: true });
  await dot.click();
  await expect(panel).toHaveCount(0);
  await dot.click();
  await expect(panel).toBeVisible();
  const heights = await page.evaluate(() => ({
    panel: document.querySelector(".stuck-panel")!.getBoundingClientRect().height,
    overview: document.querySelector(".feature-overview")!.clientHeight,
  }));
  expect(heights.panel, JSON.stringify(heights)).toBeGreaterThan(heights.overview);
  await expect(fix).toBeInViewport({ ratio: 1 });
  await expect(collapse).toBeInViewport({ ratio: 1 });
  await resizeWindow(app, 1280, 820);
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeGreaterThan(600);

  // 8. 面板开着，按键照样到终端，也有回复。
  await typeLine(page, "hello with the panel open");
  await expect.poll(() => terminalText(page)).toContain("收到：hello with the panel open");
  await expect(panel).toBeVisible();

  // 9. 点这一行的其他位置和“看终端”都进 ticket 页。在别的页面上，侧栏的 feature 行也有红点。回来时面板还开着。
  await row("DMS-1").locator(".status").click();
  await onTicketPage("DMS-1");
  await expect(page.locator(".sidebar .feature-group .stuck-mark")).toBeVisible();
  await featurePage();
  await expect(panel).toBeVisible();
  // 面板是记住的状态，不是这次点开的：回到这一页不滚动。
  expect(await overviewScroll()).toBe(0);
  await panel.getByRole("button", { name: S.stuckViewTerminal, exact: true }).click();
  await onTicketPage("DMS-1");
  await featurePage();

  // 10. “没事，忽略”（activity:dismiss）：红点消失；没有新动静就不再判断、不再提醒。
  await panel.getByRole("button", { name: S.stuckDismiss, exact: true }).click();
  await expect(dot).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await page.waitForTimeout(4 * STUCK_CHECK_MS);
  await expect(dot).toHaveCount(0);
  expect(judgePrompts()).toHaveLength(1);
  expect(await notifications(app)).toHaveLength(1);

  // 11. 命令又有输出之后再卡住：再判断一次、再提醒一次，面板显示新的输出。面板记着开，这次是自己出现的，不滚动。
  await scrollOverviewToTop();
  appendFileSync(outputFile, "step 9 of 8\n");
  await expect(dot).toBeVisible();
  await expect.poll(() => notifications(app)).toHaveLength(2);
  expect(judgePrompts()).toHaveLength(2);
  await expect(panel.locator(".stuck-log")).toContainText("step 9 of 8");
  expect(await overviewScroll()).toBe(0);

  // 12. 还卡着的时候有了新输出：红点自己消失，不用等下一次判断。之后再卡住一次，给后面的步骤用。
  appendFileSync(outputFile, "step 10 of 8\n");
  await expect(dot).toHaveCount(0);
  await expect(dot).toBeVisible();
  await expect.poll(() => notifications(app)).toHaveLength(3);

  // 13. “开新 session 解决”（session:openFix）：feature 页上多一个“修复 DMS-1”的 session，切到它的终端。
  await fix.click();
  const fixButton = page.locator(".feature-page .sessions-bar .session").filter({ hasText: S.fixSessionFor("DMS-1") });
  await expect(fixButton).toHaveClass(/active/);
  const fixId = (await fixButton.getAttribute("title"))!.split("\n")[1];
  expect(fixId).toBeTruthy();
  expect(fixId).not.toBe(coordinatorId);

  // 14. 新 session 收到任务：四条规则、两个 session 的名字（登记文件里查到的）、卡住 session 的资料。
  const fixTranscript = join(s.claudeConfigDir, "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"), `${fixId}.jsonl`);
  const firstMessage = () => {
    if (!existsSync(fixTranscript)) return "";
    const line = readFileSync(fixTranscript, "utf8").split("\n")[0];
    return (JSON.parse(line) as { message: { content: string } }).message.content;
  };
  await expect.poll(firstMessage).toContain("Butler 开了这个 session 来解决一个卡住的 session。");
  const task = firstMessage();
  expect(task).toContain("1. 目标是让卡住的 session 能继续，不接手那个 ticket 的工作。");
  expect(task).toContain("2. 要杀进程时先问用户，用户确认后才杀。");
  expect(task).toContain("3. 改 branch、停进程这类可能影响原 session 的事，先用 SendMessage 告诉原 session，再动手。其他事不用同步。");
  expect(task).toContain(`4. 解决后用 SendMessage 告诉总控 session fake-${coordinatorId.slice(0, 8)} 问题已解决。`);
  expect(task).toContain(`session：${stuckId}`);
  expect(task).toContain(`名字：fake-${stuckId.slice(0, 8)}`);
  expect(task).toContain(`目录：${worktree}`);
  expect(task).toContain(`原因：${VERDICT_REASON.zh}`);
  expect(task).toContain("step 10 of 8");
  await expect.poll(() => terminalText(page)).toContain("step 10 of 8");

  // 15. 不存成总控；原 session 不受影响，还是卡住的。同一个卡住的 session 再点一次，回到同一个修复 session。
  expect(dbRows(s, "SELECT coordinator, fixes_session AS fixes, ticket_key AS ticket FROM sessions WHERE id = ?", fixId)).toEqual([{ coordinator: 0, fixes: stuckId, ticket: null }]);
  await expect(dot).toBeVisible();
  await fix.click();
  await expect(page.locator(".feature-page .sessions-bar .session")).toHaveCount(2);

  // 16. 点通知（feature 页已经开着，ticket 区收起、面板关着）：窗口回来，展开 ticket 区和面板，页面不重新挂载，当前终端不变。
  //     切到排在后面的那个终端：页面重新挂载的话，当前终端会回到第一个。
  await page.locator(".feature-page .sessions-bar .session").last().click();
  const active = page.locator(".feature-page .sessions-bar .session.active");
  const activeTitle = (await active.getAttribute("title"))!;
  const screen = await terminalText(page);
  await page.evaluate(() => document.querySelector(".feature-page")!.setAttribute("data-e2e-mounted", "1"));
  // 面板已经开着但滚出了视野：点通知也要滚过去，再点一次也一样。
  for (let i = 0; i < 2; i++) {
    await scrollOverviewToTop();
    await expect(fix).not.toBeInViewport();
    await clickNotification(app, 2);
    await expect(fix).toBeInViewport();
  }
  await dot.click();
  await expect(panel).toHaveCount(0);
  await page.locator(".feature-page .feature-tickets .section-toggle").click();
  await expect(page.locator(".feature-page .ticket-table")).toHaveCount(0);
  await expect(page.locator(".feature-page .feature-tickets .stuck-mark")).toBeVisible();
  await hideWindow(app);
  await clickNotification(app, 0);
  await expect.poll(() => windowVisible(app)).toBe(true);
  await expect(fix).toBeInViewport();
  await expect(page.locator(".feature-page[data-e2e-mounted]")).toHaveCount(1);
  await expect(active).toHaveAttribute("title", activeTitle);
  expect(await terminalText(page)).toBe(screen);

  // 17. 在别的页面上点通知：打开这个 feature 页，展开面板。
  await dot.click();
  await expect(panel).toHaveCount(0);
  await ticketPage("DMS-2");
  await clickNotification(app, 1);
  await onFeaturePage();
  await expect(fix).toBeInViewport();
  // 通知只滚这一次：再回到这一页不滚动。
  await ticketPage("DMS-2");
  await featurePage();
  await expect(panel).toBeVisible();
  expect(await overviewScroll()).toBe(0);

  // 18. 修复 session 比总控新，但 feature 汇总还是 fork 总控：它不会被选成总控。
  const progress = page.locator(".feature-page .feature-progress");
  await progress.getByRole("button", { name: S.runFeatureSummary, exact: true }).click();
  await expect(progress.getByText(S.featureSummaryStored, { exact: true })).toBeVisible();
  expect(fakeLog()).toContain(`--resume ${coordinatorId} --fork-session`);
  expect(fakeLog()).not.toContain(`--resume ${fixId}`);

  // 19. 卡住的 session 还在被监视时退出：监视先停，数据库才关，日志里没有错误。
  expect(pageErrors).toEqual([]);
  await app.close();
  const log = () => readFileSync(join(s.butlerHome, "logs", "main.log"), "utf8");
  expect(log()).not.toMatch(/activity tick failed|activity of session|stuck judge/);

  // 20. 重启后是英文：卡住状态不留，DMS-2 新跑的命令重新判断，判断结果和界面都是英文。
  s.lang = "en";
  const E = STRINGS.en;
  const english = await launch(s);
  const en = english.page;
  await captureNotifications(english.app);
  await en.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-2" }).click();
  await en.getByRole("button", { name: `+ ${E.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(en)).toContain("fake claude ready");
  await typeLine(en, "/fake-bash git push origin feature/checkout");
  await en.locator(".sidebar .ticket.feature").click();
  const enRow = en.locator(".feature-page .ticket-table tr").filter({ hasText: "DMS-2" });
  await expect(enRow.locator(".activity .main")).toHaveText(E.activity.push);
  await expect(enRow.getByRole("button", { name: `DMS-2 ${E.stuckDot}`, exact: true })).toBeVisible();
  await expect(enRow.locator(".activity small")).toContainText(E.activitySilent(E.durationMinutes(1)));
  await enRow.getByRole("button", { name: `DMS-2 ${E.stuckDot}`, exact: true }).click();
  const enPanel = en.locator(".stuck-panel");
  await expect(enPanel).toContainText(VERDICT_REASON.en);
  await expect(enPanel).toContainText(VERDICT_ACTION.en);
  await expect(enPanel.getByRole("button", { name: E.stuckFix, exact: true })).toBeVisible();
  await shot(en, "live-status-en.png", "light");
  await shot(en, "live-status-en-dark.png", "dark");
});

/**
 * 设计文档 2026-10-31：这一轮结束了但后台命令还在跑，session 在等命令，不是等用户，状态列显示命令并标“后台”；
 * 完成通知之后回到“等你回话”。检查间隔保持 3 分钟，这个测试不会走到卡住判断。
 */
test("live status: a background command stays on the row after its turn ends", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200" };
  const { page } = await launch(s);
  await completeWizard(page, s);
  await createCheckoutFeature(page, s);
  await newFeatureTicket(page, "DMS-1", "frontend");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, "/fake-bg git push origin feature/checkout");
  await expect.poll(() => terminalText(page)).toContain("收到：/fake-bg git push");

  await page.locator(".sidebar .ticket.feature").click();
  const row = page.locator(".feature-page .ticket-table tr").filter({ hasText: "DMS-1" });
  await expect(row.locator(".activity .main")).toHaveText(S.activityBackground(S.activity.push));
  // 没有卡住的行也带完整文字的提示：这一列放不下时靠它看全。
  await expect(row.locator(".activity small")).toHaveAttribute("title", S.durationNow);
  await expect(row.locator(".badge")).toBeVisible();

  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  await typeLine(page, "/fake-bg-done");
  await page.locator(".sidebar .ticket.feature").click();
  await expect(row.locator(".activity .main")).toHaveText(S.activity.waiting);
  await expect(row.locator(".stuck-dot")).toHaveCount(0);
});
