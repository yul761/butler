import type { ElectronApplication, Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { S, STRINGS, type UiStrings } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, openArchived, openTab, openTicketTab, pageTab, terminalText, test, type Sandbox, newButton } from "./fixtures";

/** 在沙盒里建 shop/frontend、shop/backend 两个仓库，选上一层目录建 feature「checkout」（两个仓库默认都勾上）。 */
async function createCheckoutFeature(page: Page, s: Sandbox): Promise<void> {
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await (await newButton(page, "newFeature")).click();
  await page.getByLabel(S.featureName, { exact: true }).fill("checkout");
  const dir = page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true });
  await dir.fill(shop);
  await dir.blur();
  await expect(page.getByText(S.subReposFound(2), { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "frontend", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "backend", exact: true })).toBeChecked();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
  // 新 feature 停在「概况」；仓库条在「总控」页签里。
  await expect(pageTab(page, S.lay.tabOverview)).toHaveAttribute("aria-selected", "true");
  await openTab(page, S.lay.tabControl);
  await expect(page.locator(".feature-page .repos-bar .repo .name")).toHaveText(["backend", "frontend"]);
}

/** feature 页「全部 ticket」里的一行（按 ticket 号认）。 */
const ticketRow = (page: Page, key: string) =>
  page.locator(".feature-page .ticket-table tbody tr").filter({ has: page.locator(".key", { hasText: new RegExp(`^${escapeRe(key)}$`) }) });

/** 在当前 feature 页的「总控」页签新开一个总控。 */
async function newCoordinator(page: Page, T: UiStrings = S): Promise<void> {
  await openTab(page, T.lay.tabControl);
  await page.locator(".feature-page").getByRole("button", { name: `+ ${T.newCoordinator}`, exact: true }).click();
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

type McpServerConfig = { command: string; args: string[]; env: Record<string, string> };
type ToolReply = { content: { text: string }[]; isError?: boolean };

/** 按 mcp 配置启动 shipherd-sessions，像 claude 一样经 stdio 调用工具（from 是总控自己的 session id）。 */
async function sessionsServer(server: McpServerConfig, from: string): Promise<{ call: (name: string, args?: object) => Promise<ToolReply>; close: () => void }> {
  const child = spawn(server.command, server.args, {
    env: { ...server.env, SHIPHERD_SESSION: from, PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const replies = createInterface({ input: child.stdout });
  let next = 0;
  const send = (method: string, params: object) => new Promise<{ result: ToolReply }>((resolve) => {
    const id = ++next;
    const onLine = (l: string) => {
      const msg = JSON.parse(l) as { id: number; result: ToolReply };
      if (msg.id !== id) return;
      replies.off("line", onLine);
      resolve(msg);
    };
    replies.on("line", onLine);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  return { call: async (name, args = {}) => (await send("tools/call", { name, arguments: args })).result, close: () => child.kill() };
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
 * → feature 总控在工作区里打开 → 按 mcp 配置启动 shipherd-sessions，start_session 给前端 ticket 开子 session
 * → 子 session 退出后 handoff 报告 PR 已合并 → 前端 ticket 的 worktree 被自动清理。
 * end_session（计划 11 任务 11）：总控结束一个停下来在等输入的子 session，终端退出、session 还在列表里；正在跑命令的 session 被拒绝。
 */
test("a feature over a parent directory: tickets' worktrees in its workspace, a coordinator, cleanup after merge", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  // end_session 要看活动：刷新调快，不用等 10 秒。
  s.env = { SHIPHERD_ACTIVITY_TICK_MS: "200" };
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

  // 3. feature 总控：在工作区里打开（worktree 都在里面，不需要 --add-dir），挂 feature 记忆和 feature 模式的 shipherd-sessions。
  await page.locator(".sidebar .ticket.feature").click();
  await newCoordinator(page);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await expect.poll(fakeLog).toContain(`mcp=shipherd-workspace,shipherd-feature,shipherd-sessions cwd=${workspace} adddirs= guide=`);
  const coordinatorId = /interactive new (\S+) mcp=shipherd-workspace,shipherd-feature,shipherd-sessions/.exec(fakeLog())![1];

  // 4. 按配置启动 shipherd-sessions，像 claude 一样经 stdio 调用：给 DMS-1（只有一个仓库，不用指定 repo）开子 session。
  const config = JSON.parse(readFileSync(join(s.shipherdHome, "mcp", "features", "1.json"), "utf8")) as { mcpServers: Record<string, McpServerConfig> };
  const server = config.mcpServers["shipherd-sessions"];
  expect(server.env.SHIPHERD_FEATURE).toBe("1");
  const mcp = await sessionsServer(server, coordinatorId);
  let started: { sessionId: string; ticket: string; repo: string };
  try {
    const listed = JSON.parse((await mcp.call("list_tickets")).content[0].text) as { key: string }[];
    expect(listed.map((t) => t.key)).toEqual(["DMS-1", "DMS-2"]);
    const reply = await mcp.call("start_session", { ticket: "DMS-1", task: "build-the-cart" });
    expect(reply.isError).toBeUndefined();
    started = JSON.parse(reply.content[0].text) as typeof started;
    // epic 里的 feature（BTL-246）：Cart 排在 Payment 前面；名字不分大小写不能重复。
    expect(JSON.parse((await mcp.call("create_feature", { name: "Payment" })).content[0].text)).toMatchObject({ name: "Payment" });
    expect((await mcp.call("create_feature", { name: "Cart", before: "Payment" })).isError).toBeUndefined();
    expect((await mcp.call("create_feature", { name: "payment" })).isError).toBe(true);
    expect(JSON.parse((await mcp.call("set_ticket_feature", { ticket: "DMS-1", feature: "Cart" })).content[0].text)).toEqual({ ticket: "DMS-1", feature: "Cart" });
    // 总控直接建 ticket：DMS-3 用 backend，建在 Payment 里，马上出现在侧栏的 feature 下面。
    const created = await mcp.call("create_ticket", { ticket: "dms-3", title: "Refunds", repos: ["backend"], feature: "Payment" });
    expect(created.isError).toBeUndefined();
    expect(JSON.parse(created.content[0].text)).toMatchObject({ key: "DMS-3", feature: "Payment", repos: [{ name: "backend", dir: join(workspace, "backend-dms-3") }] });
    const blocks = JSON.parse((await mcp.call("list_features")).content[0].text) as { features: { name: string; tickets: { key: string }[] }[]; notInAFeature: { key: string }[] };
    expect(blocks.features.map((f) => [f.name, f.tickets.map((t) => t.key)])).toEqual([["Cart", ["DMS-1"]], ["Payment", ["DMS-3"]]]);
    expect(blocks.notInAFeature.map((t) => t.key)).toEqual(["DMS-2"]);
  } finally {
    mcp.close();
  }
  expect(started).toMatchObject({ ticket: "DMS-1", repo: "frontend" });
  await expect(page.locator(".sidebar .feature-group .feature-tickets .ticket .key")).toHaveText(["DMS-1", "DMS-2", "DMS-3"]);
  expect(existsSync(join(workspace, "backend-dms-3"))).toBe(true);
  // 概况按 feature 一行一个（顺序同 list_features，最后是不在 feature 里的）；第一个没合完的展开，点开 Payment 看到 DMS-3。
  await openTab(page, S.lay.tabOverview);
  const blockRows = page.locator(".feature-page .scope-block");
  await expect(blockRows.locator("summary .name")).toHaveText(["Cart", "Payment", S.lay.notInAFeature]);
  await expect(blockRows.nth(0).locator(".ticket-table button.key")).toHaveText(["DMS-1"]);
  await expect(blockRows.nth(1).locator(".ticket-table")).toBeHidden();
  await blockRows.nth(1).locator("summary").click();
  await expect(blockRows.nth(1).locator(".ticket-table button.key")).toHaveText(["DMS-3"]);
  // 「全部 ticket」也按 feature 分组。
  await openTab(page, S.lay.tabTickets);
  await expect(page.locator(".feature-page .ticket-table .group-row")).toHaveText([S.lay.groupHeader("Cart", 0, 1), S.lay.groupHeader("Payment", 0, 1), S.lay.groupHeader(S.lay.notInAFeature, 0, 1)]);
  await openTab(page, S.lay.tabControl);
  // 子 session 是 DMS-1 的普通 session：在它的 worktree 里，挂 ticket 记忆和 feature 记忆，没有 shipherd-sessions。
  await expect.poll(fakeLog).toContain(`interactive new ${started.sessionId} mcp=shipherd-memory,shipherd-workspace,shipherd-feature,shipherd-sessions cwd=${feWorktree} adddirs= guide=`);

  // 5. 在 DMS-1 的「终端」页签里看到子 session，等任务提交后用按钮旁的 × 结束它（点两次；这个仓库自己的终端在跑时不会清理）。
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  await openTicketTab(page, "terminal");
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

  // 5b. end_session：总控再给 DMS-1 开一个子 session，等它回完话停下来等输入，然后结束它 → 终端退出，session 还在列表里，可以再打开。
  // 下面 6. 的 handoff 清理 worktree 要求 DMS-1 没有终端在跑：也确认了终端真的关了。
  const boss = await sessionsServer(server, coordinatorId);
  try {
    const second = JSON.parse((await boss.call("start_session", { ticket: "DMS-1", task: "second-task" })).content[0].text) as { sessionId: string };
    const rowOf = async (id: string) => {
      const rows = JSON.parse((await boss.call("list_sessions")).content[0].text) as { id: string; waitingForInput: boolean; activity: { kind: string } | null; last_reply: string | null }[];
      const r = rows.find((x) => x.id === id);
      return r && { waiting: r.waitingForInput, kind: r.activity?.kind ?? null, lastReply: r.last_reply };
    };
    await expect.poll(() => rowOf(second.sessionId), { timeout: 30_000 }).toMatchObject({ waiting: true, kind: "waiting", lastReply: expect.stringContaining("second-task") });
    const ended = await boss.call("end_session", { session: second.sessionId, reason: "second-task 已经做完" });
    expect(ended.isError).toBeUndefined();
    expect(JSON.parse(ended.content[0].text)).toEqual({ ended: true });
    const children = page.locator(".sessions-bar .session-wrap").filter({ has: page.locator(`[title="${S.spawnedByCoordinator}"]`) });
    await expect(children).toHaveCount(2);
    await expect(children.locator(".session .action")).toHaveText([S.open, S.open]);
    // 已经结束的再结束一次：Shipherd 说它已经结束了。
    await expect.poll(async () => (await boss.call("end_session", { session: second.sessionId, reason: "again" })).content[0].text).toContain("已经结束");

    // 6. 更新状态（概况的「状态」一节，BTL-244）：假 claude 报告 PR 已合并 → worktree 被删掉（分支保留），仓库一行标着“已清理”。总控还开着也不拦。
    await openTicketTab(page, "overview");
    await page.getByTestId("ticket-status").getByRole("button", { name: S.runHandoff, exact: true }).click();
    await expect(page.getByTestId("ticket-status").locator(".handoff-entry")).toBeVisible();
    await openTicketTab(page, "terminal");
    await expect(page.locator(".repos-bar").getByText(S.worktreeRemoved, { exact: true })).toBeVisible();
    expect(existsSync(feWorktree)).toBe(false);
    expect(existsSync(beWorktree)).toBe(true);

    // 6b. 正在跑命令的 session：end_session 被拒绝（正在干活），终端还在。
    const busy = JSON.parse((await boss.call("start_session", { ticket: "DMS-2", task: "busy-task" })).content[0].text) as { sessionId: string };
    await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-2" }).click();
    await openTicketTab(page, "terminal");
    const busyWrap = page.locator(".sessions-bar .session-wrap").filter({ has: page.locator(`[title="${S.spawnedByCoordinator}"]`) });
    await busyWrap.locator(".session").click();
    await expect.poll(() => terminalText(page)).toContain("收到：总控 session 交给你的任务：");
    await typeLine(page, `/fake-bash ${LONG_COMMAND}`);
    await expect.poll(() => rowOf(busy.sessionId), { timeout: 30_000 }).toMatchObject({ kind: "test" });
    const refused = await boss.call("end_session", { session: busy.sessionId, reason: "想关掉" });
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("正在干活（test）") }] });
    await page.waitForTimeout(500);
    await expect(page.locator(".terminal-wrap:visible")).toHaveCount(1);
    await expect(page.locator(".terminal-wrap:visible .exited")).toHaveCount(0);
    await expect(busyWrap.locator(".session .action")).not.toHaveText(S.open);
  } finally {
    boss.close();
  }

  // 7. feature 总控说过话、退出之后可以从列表里隐藏，也能在 feature 页上恢复。
  await page.locator(".sidebar .ticket.feature").click();
  await openTab(page, S.lay.tabControl);
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
 * → 总控里 /handoff 输出 shipherd-feature-handoff → feature 页显示汇总、卡住和下一步，来源是“总控 /handoff”
 * → 后台给有活动的 DMS-2 跑了 handoff（DMS-1 没有新活动，不跑），ticket 表里两个 ticket 都有 PR 标签
 * → “立即更新”生成新的汇总，来源变成“手动更新” → 切到英文后再更新一次，界面和汇总都是英文。
 * 设了 SHIPHERD_E2E_SHOTS_DIR 时把中英文的 feature 页各截一张图存到那里（CI 不设）。
 */
/**
 * 工作流 W（按内存决定能开几个 session）：可用内存不够时 start_session 被拒，提示里写出现在可用多少、再开一个要多少、要留多少，
 * 不开终端；list_sessions 附的那一行说还能再开 0 个。可用内存用 SHIPHERD_E2E_AVAILABLE_MB 定死，不看这台机器。
 */
test("start_session is refused when memory is short, with how much is available and needed", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  // 1000 MB：自动保留线最少 512 MB，加上预估的 1024 MB，在哪台机器上都不够。
  s.env = { SHIPHERD_E2E_AVAILABLE_MB: "1000" };
  const feWorktree = join(s.dir, "shop-features", "checkout", "frontend-dms-1");
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const { page } = await launch(s);
  await completeWizard(page, s);
  await createCheckoutFeature(page, s);
  await newFeatureTicket(page, "DMS-1", "frontend");
  await page.locator(".sidebar .ticket.feature").click();
  await newCoordinator(page);
  await expect.poll(fakeLog).toContain("mcp=shipherd-workspace,shipherd-feature,shipherd-sessions");
  const coordinatorId = /interactive new (\S+) mcp=shipherd-workspace,shipherd-feature,shipherd-sessions/.exec(fakeLog())![1];
  const config = JSON.parse(readFileSync(join(s.shipherdHome, "mcp", "features", "1.json"), "utf8")) as { mcpServers: Record<string, McpServerConfig> };
  const mcp = await sessionsServer(config.mcpServers["shipherd-sessions"], coordinatorId);
  try {
    const refused = await mcp.call("start_session", { ticket: "DMS-1", task: "build-the-cart" });
    expect(refused.isError).toBe(true);
    const text = refused.content[0].text;
    expect(text).toContain("内存不够再开一个 session：现在可用 1000 MB");
    expect(text).toContain("再开一个预计要 1.0 GB");
    expect(text).toMatch(/开完还要留 (\d+ MB|\d+\.\d GB) 给系统/);
    const listed = await mcp.call("list_sessions");
    expect(listed.content.map((c) => c.text).join("\n")).toContain("现在还能再开 0 个 session（按内存算）：可用 1000 MB，每个按 1.0 GB 算");
  } finally {
    mcp.close();
  }
  // 没有给 DMS-1 开终端。
  await page.waitForTimeout(500);
  expect(fakeLog()).not.toContain(`cwd=${feWorktree}`);
});

test("feature summary: the coordinator's /handoff, child tickets' handoffs and the update button", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const workspace = join(s.dir, "shop-features", "checkout");
  const feWorktree = join(workspace, "frontend-dms-1");
  const beWorktree = join(workspace, "backend-dms-2");
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const sessionIn = (cwd: string) => new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${escapeRe(cwd)} `).exec(fakeLog())?.[1];
  // 只数 handoff 的 fork：需要你的判断（--model haiku）不算，transcript 有 fs.watch 以后它跑得早，什么时候跑不固定。
  const headlessLines = () => fakeLog().split("\n").filter((l) => / headless .*--json-schema/.test(l) && !/ --model haiku /.test(l));
  const shots = process.env.SHIPHERD_E2E_SHOTS_DIR;
  const { app, page } = await launch(s);
  await completeWizard(page, s);

  await createCheckoutFeature(page, s);
  await newFeatureTicket(page, "DMS-1", "frontend");
  await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();
  await newFeatureTicket(page, "DMS-2", "backend");
  const ticketPage = (key: string) => page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: key }).click();
  const featurePage = () => page.locator(".sidebar .ticket.feature").click();

  // 1. DMS-1：在自己的 session 里 /handoff（ticket 的 shipherd-handoff 代码块，PR 还开着、已 approve）。
  await ticketPage("DMS-1");
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, "/handoff");
  await expect.poll(() => terminalText(page)).toContain("next_steps");

  // 2. DMS-2：session 里有新的对话（之后算“有活动”），还没有 handoff。
  await ticketPage("DMS-2");
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, "build the order api");
  await expect.poll(() => terminalText(page)).toContain("收到：build the order api");
  const dms2Session = sessionIn(beWorktree)!;
  expect(dms2Session).toBeTruthy();

  // 「AI 总结」里还没有汇总；「全部 ticket」里 DMS-1 已有 PR（只有一个 PR，标签不带仓库名），DMS-2 还没有（PR 一列是 —）。
  await featurePage();
  const progress = page.locator(".feature-page .feature-progress");
  const row = (key: string) => ticketRow(page, key);
  const prCell = (key: string) => row(key).locator("td").last();
  await openTab(page, S.lay.tabSummary);
  await expect(progress.getByText(S.featureSummaryNone, { exact: true })).toBeVisible();
  await openTab(page, S.lay.tabTickets);
  await expect(progress).toHaveCount(0);
  await expect(prCell("DMS-1")).toHaveText("#12");
  await expect(prCell("DMS-2")).toHaveText("—");
  // 停在哪个 tab 记着：离开再回来还是 ticket 表。再点一下当前 tab 不会收起；「新建 ticket」一直在 tab 条上。
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  await featurePage();
  await expect(pageTab(page, S.lay.tabTickets)).toHaveAttribute("aria-selected", "true");
  await expect(row("DMS-1")).toBeVisible();
  await pageTab(page, S.lay.tabTickets).click();
  await expect(page.locator(".feature-page .page-tabs-panel")).toHaveCount(1);
  await expect(row("DMS-1")).toBeVisible();
  await expect(page.locator(".feature-page .page-tabs-bar").getByRole("button", { name: `+ ${S.newTicket}`, exact: true })).toBeVisible();

  // 3. 总控里 /handoff：输出 shipherd-feature-handoff，存成 feature 汇总。
  await newCoordinator(page);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const coordinatorId = sessionIn(workspace)!;
  expect(coordinatorId).toBeTruthy();
  await typeLine(page, "/handoff");
  await openTab(page, S.lay.tabSummary);
  const summary = progress.locator(".feature-summary");
  await expect(summary.locator("p").first()).toHaveText("结账页前端（DMS-1）已提 PR 等合并；后端下单接口（DMS-2）还在写，两边还没联调。");
  await expect(summary.locator(".blocker")).toHaveText([S.labelled(S.featureBlocked, "DMS-2 等支付网关的测试账号")]);
  await expect(summary.getByText(S.nextSteps, { exact: true })).toBeVisible();
  // 小写的 dms-2 规范成了本 feature 的 DMS-2，能点。
  await expect(summary.locator("li")).toHaveText(["DMS-2 写完下单接口", "两边合并后联调结账流程"]);
  await expect(summary.locator("li").first().getByRole("button", { name: "DMS-2", exact: true })).toBeVisible();
  await expect(progress.locator(".summary-meta .muted").first()).toContainText(S.featureSummaryTrigger.command);

  // 4. /handoff 之后后台给有活动的 DMS-2 跑了 handoff（fork 它的 session）：PR 已合并。DMS-1 没有新活动，不跑。
  //    每个 ticket 的 PR 都在一个仓库里，标签不带仓库名（只有一个 ticket 跨仓库开了 PR 才带）；DMS-2 合了，谁该动是「做完了」。
  await openTab(page, S.lay.tabTickets);
  await expect(prCell("DMS-2")).toHaveText("#7");
  await expect(prCell("DMS-1")).toHaveText("#12");
  await expect(row("DMS-2").locator(".who")).toHaveText(S.hm.whoDone);
  expect(headlessLines()).toHaveLength(1);
  expect(headlessLines()[0]).toContain(`--resume ${dms2Session} --fork-session`);
  expect(headlessLines()[0]).toContain(`cwd=${beWorktree}`);
  // DMS-1 没有跑 handoff。Haiku 判断「需要你」也是 headless、也在它的目录里跑，不算（headlessLines 已经去掉了）。
  expect(headlessLines().filter((l) => l.includes(`cwd=${feWorktree}`))).toEqual([]);

  // 5. “立即更新”：子 ticket 都没有新活动，直接 fork 总控生成汇总；来源变成“手动更新”。
  await openTab(page, S.lay.tabSummary);
  await progress.getByRole("button", { name: S.runFeatureSummary, exact: true }).click();
  await expect(progress.getByText(S.featureSummaryStored, { exact: true })).toBeVisible();
  await expect(summary.locator("p").first()).toHaveText("后端下单接口（DMS-2）已合并；前端结账页（DMS-1）的 PR 已 approve，合并后就能联调。");
  await expect(summary.locator(".blocker")).toHaveText([S.labelled(S.featureBlocked, "DMS-1 等支付表单的设计 review")]);
  await expect(summary.locator("li")).toHaveText(["DMS-1 合并结账页的 PR", "在 staging 联调结账流程"]);
  await expect(progress.locator(".summary-meta .muted").first()).toContainText(S.featureSummaryTrigger.manual);
  expect(headlessLines()).toHaveLength(2);
  expect(headlessLines()[1]).toContain(`--resume ${coordinatorId} --fork-session`);

  // 「AI 总结」tab 上标着卡住的条数，不用打开也看得到。离开再回来还停在它上面；「总控」里终端至少占窗口一半高。
  const summaryTab = pageTab(page, S.lay.tabSummary);
  await expect(summaryTab.locator(".blocker")).toHaveText(S.featureBlockedCount(1));
  await ticketPage("DMS-1");
  await featurePage();
  await expect(summaryTab).toHaveAttribute("aria-selected", "true");
  await expect(summary.locator("p").first()).toBeVisible();
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, "feature-page-zh.png") });
  }
  await openTab(page, S.lay.tabControl);
  await expectTerminalsKeepHalf(page);

  // 6. 切到英文（同 language.spec：不设 SHIPHERD_LANG 重启，在设置里选 English，窗口重新加载）后再更新一次。
  await app.close();
  s.lang = null;
  const en = (await launch(s)).page;
  const E = STRINGS.en;
  await en.locator(".sidebar button.nav").filter({ hasText: new RegExp(`^(${STRINGS.zh.settings}|${E.settings})$`) }).click();
  await en.locator(".language-picker select").selectOption("en");
  await expect(en.locator(".sidebar button.nav").filter({ hasText: new RegExp(`^${E.settings}$`) })).toBeVisible();
  await en.locator(".sidebar .ticket.feature").click();
  const enProgress = en.locator(".feature-page .feature-progress");
  await openTab(en, E.lay.tabSummary);
  await enProgress.getByRole("button", { name: E.runFeatureSummary, exact: true }).click();
  await expect(enProgress.getByText(E.featureSummaryStored, { exact: true })).toBeVisible();
  await expect(enProgress.locator(".feature-summary p").first()).toContainText("The backend order API (DMS-2) is merged");
  await expect(enProgress.locator(".blocker")).toHaveText([E.labelled(E.featureBlocked, "DMS-1 is waiting for the design review of the payment form")]);
  await expect(enProgress.locator(".summary-meta .muted").first()).toContainText(E.featureSummaryTrigger.manual);
  if (shots) await en.screenshot({ path: join(shots, "feature-page-en.png") });
  // 「全部 ticket」的英文：DMS-2 的 PR 标签、谁该动和那句话。
  await openTab(en, E.lay.tabTickets);
  const enRow = ticketRow(en, "DMS-2");
  await expect(enRow.locator("td").last()).toHaveText("#7");
  await expect(enRow.locator(".who")).toHaveText(E.hm.whoDone);
  await expect(enRow.locator("td").nth(2)).toHaveText(E.turn.done);
});

/**
 * 总控页签的右栏（UI 重做第 3 层）：总控和子 session 的汇报按时间排开，又多又长时在右栏里，不挤掉左边的终端。
 * 汇报已处理过（dismissed），不会送进总控。
 */
test("the feature's control tab: reports on the right, the terminal keeps its half", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const workspace = join(s.dir, "shop-features", "checkout");
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const { page } = await launch(s);
  await completeWizard(page, s);
  await createCheckoutFeature(page, s);
  // 还没有汇报：右栏说还没有对话。
  await expect(page.locator(".feature-page .control-right .control-feed")).toContainText(S.lay.ctlEmpty);
  await newCoordinator(page);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const coordinatorId = new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${escapeRe(workspace)} `).exec(fakeLog())![1];

  const long = "很长的一段汇报，".repeat(40);
  const db = new DatabaseSync(join(s.shipherdHome, "app.db"));
  const [{ id: featureId }] = db.prepare("SELECT id FROM features WHERE name = 'checkout'").all() as { id: number }[];
  const insert = db.prepare("INSERT INTO inbox_items (kind, session_id, feature_id, text, context, report_kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const at = Date.now();
  for (let n = 0; n < 12; n++) insert.run("report", coordinatorId, featureId, `${n} ${long}`, null, "done", "dismissed", at - n * 1000);
  db.close();
  // 重新进 feature 页（汇报是直接写进数据库的，没有通知）：页面记着停在「总控」。
  await page.getByRole("button", { name: S.home, exact: true }).click();
  await page.locator(".sidebar .ticket.feature").click();
  await expect(pageTab(page, S.lay.tabControl)).toHaveAttribute("aria-selected", "true");
  const reports = page.locator(".feature-page .control-right .inbox-report");
  await expect(reports).toHaveCount(12);
  // 从早到晚：最早的（n = 11）在最上面。
  await expect(reports.first().locator("p")).toHaveText(`11 ${long}`);
  await expect(reports.last().locator("p")).toHaveText(`0 ${long}`);
  // tab 条一直看得到，终端区至少占窗口一半高、整个在窗口里。
  await expect(pageTab(page, S.lay.tabOverview)).toBeInViewport();
  await expectTerminalsKeepHalf(page);
  await expect(page.locator(".feature-page .terminal-wrap:visible")).toBeInViewport();

  // 右栏可以收起：左边终端占满；再点展开。epic/feature 页各自记着（这里只收这一页）。
  const split = page.locator(".feature-page .control-split");
  await split.getByRole("button", { name: S.lay.ctlCollapse, exact: true }).click();
  await expect(split.locator(".control-right")).toBeHidden();
  await expect(page.locator(".feature-page .terminal-wrap:visible")).toBeInViewport();
  await split.getByRole("button", { name: S.lay.ctlExpand, exact: true }).click();
  await expect(split.locator(".control-right")).toBeVisible();
});

/**
 * 待你决定（UI 重做第 3 层）：不再是 feature 页的一个 tab。总控 ask_user 的问题是 feature「概况」里一张「轮到你」的卡片，
 * 「概况」页签标着要你看；首页也有这张卡片。
 */
test("a coordinator's question is a turn card on the feature overview", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const workspace = join(s.dir, "shop-features", "checkout");
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const { page } = await launch(s);
  await completeWizard(page, s);
  await createCheckoutFeature(page, s);
  await newCoordinator(page);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const coordinatorId = new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${escapeRe(workspace)} `).exec(fakeLog())![1];

  const db = new DatabaseSync(join(s.shipherdHome, "app.db"));
  const [{ id: featureId }] = db.prepare("SELECT id FROM features WHERE name = 'checkout'").all() as { id: number }[];
  db.prepare("INSERT INTO inbox_items (kind, session_id, feature_id, text, context, report_kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("decision", coordinatorId, featureId, "要不要先联调？", null, null, "pending", Date.now());
  db.close();
  await page.getByRole("button", { name: S.home, exact: true }).click();
  const homeCard = page.getByTestId("turn-card").filter({ hasText: "要不要先联调？" });
  await expect(homeCard).toHaveAttribute("data-kind", "answer");
  await page.locator(".sidebar .ticket.feature").click();
  await expect(pageTab(page, S.lay.tabOverview)).toHaveClass(/\battention\b/);
  await openTab(page, S.lay.tabOverview);
  const card = page.locator(".feature-page .scope-you").getByTestId("turn-card");
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-kind", "answer");
  await expect(card.locator(".turn-tag")).toHaveText(S.hm.kind.answer);
  await expect(card.locator(".sentence")).toContainText("要不要先联调？");
});

/** 假 claude 跑的命令：够长，状态列放不下；第一个词让它归类成“跑测试”。 */
const LONG_COMMAND = "pnpm test --filter @acme/checkout-frontend --run --reporter=verbose";
/** 假 claude 写进输出文件的内容。 */
const COMMAND_OUTPUT = Array.from({ length: 8 }, (_, i) => `step ${i + 1} of 8`);
const VERDICT_REASON = { zh: "测试进程在等一个不会来的信号", en: "The test process is waiting for a signal that will not come" };
const VERDICT_ACTION = { zh: "确认测试进程没有在动，再决定要不要杀掉重跑", en: "Check that the test process is idle, then decide whether to kill and rerun it" };
const STUCK_CHECK_MS = 1000;

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

/** 直接读 Shipherd 的数据库（只读）：有些事界面上看不出来。 */
function dbRows<T>(s: Sandbox, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(join(s.shipherdHome, "app.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/**
 * 设计文档 2026-10-31（ticket 实时状态）+ UI 重做第 3 层：假 claude 写 transcript 和真实位置的 tasks/<id>.output
 * → feature「进行中」里有它 → 本地检查（真的 ps、真的 pty pid）判定可疑，真的 headless 判断 stuck: true
 * → feature「概况」和首页各一张「卡住了」的卡片（写着理由），「全部 ticket」里那一行是卡住的颜色
 * → 首页卡片「没事，忽略」→ 卡片消失、恢复活动后再次卡住 → 卡片「开修复 session」落到「总控」，修复 session 收到四条规则，不算总控
 * → 从首页卡片「去看看」回到卡住的终端 → 重启后换成英文再卡住一次。
 * 设了 SHIPHERD_E2E_SHOTS_DIR 时截图存到那里，文件名 live-status-*.png（CI 不设）。
 */
test("live status and stuck handling on the feature page", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "Windows has no tasks directory or CPU reading in this version: only the command and duration show");
  const s = makeSandbox();
  s.env = { SHIPHERD_ACTIVITY_TICK_MS: "200", SHIPHERD_STUCK_CHECK_MS: String(STUCK_CHECK_MS) };
  const workspace = join(s.dir, "shop-features", "checkout");
  const worktree = join(workspace, "frontend-dms-1");
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const sessionIn = (cwd: string) => new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${escapeRe(cwd)} `).exec(fakeLog())?.[1];
  const judgePrompts = () => [...fakeLog().matchAll(/ judge prompt (.+)/g)].map((m) => JSON.parse(m[1]) as string);
  const shots = process.env.SHIPHERD_E2E_SHOTS_DIR;
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
  await completeWizard(page, s);
  await createCheckoutFeature(page, s);
  await newFeatureTicket(page, "DMS-1", "frontend");
  await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();
  await newFeatureTicket(page, "DMS-2", "backend");
  const ticketPage = (key: string) => page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: key }).click();
  const featurePage = () => page.locator(".sidebar .ticket.feature").click();
  const home = () => page.getByRole("button", { name: S.home, exact: true }).click();
  const onTicketPage = (key: string) => expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
  const row = (key: string) => ticketRow(page, key);
  /** 某个 ticket 的「轮到你」卡片：在首页，或者在 feature 页「概况」里。 */
  const cardOf = (key: string) => page.getByTestId("turn-card").filter({ has: page.locator(".where .key", { hasText: new RegExp(`^${key}$`) }) });
  const featureCard = (key: string) => page.locator(".feature-page .scope-you").getByTestId("turn-card").filter({ has: page.locator(".where .key", { hasText: new RegExp(`^${key}$`) }) });

  // 1. 总控开着，并且有一份汇总：修复 session 的任务里也要写上总控的名字。
  await featurePage();
  await newCoordinator(page);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const coordinatorId = sessionIn(workspace)!;
  expect(coordinatorId).toBeTruthy();
  await typeLine(page, "/handoff");
  await openTab(page, S.lay.tabSummary);
  await expect(page.locator(".feature-summary p").first()).toBeVisible();

  // 2. DMS-1 的 session 开始跑一个命令，这一轮不结束。
  await ticketPage("DMS-1");
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  const stuckId = sessionIn(worktree)!;
  expect(stuckId).toBeTruthy();
  await typeLine(page, `/fake-bash ${LONG_COMMAND}`);
  await expect.poll(fakeLog).toContain(" task output ");
  const outputFile = /task output (.+)/.exec(fakeLog())![1];

  // 3. 「进行中」里 DMS-1 是 agent 在干活；没有运行中 session 的 DMS-2 不在里面。
  await featurePage();
  await openTab(page, S.lay.tabRunning);
  const running = page.locator(".feature-page .home-run").filter({ has: page.locator(".key", { hasText: /^DMS-1$/ }) });
  await expect(running.locator(".turn-tag")).toHaveText(S.hm.whoAgent);
  await expect(page.locator(".feature-page .home-run").filter({ has: page.locator(".key", { hasText: /^DMS-2$/ }) })).toHaveCount(0);

  // 4. 两次检查没变化 → 真的 headless 判断 stuck: true（不再弹系统通知）：
  //    「概况」里一张「卡住了」的卡片写着理由，页签标着要你看；「全部 ticket」里 DMS-1 轮到你、卡住的颜色。
  await openTab(page, S.lay.tabOverview);
  const card = featureCard("DMS-1");
  await expect(card).toHaveAttribute("data-kind", "stuck");
  await expect(card.locator(".turn-tag")).toHaveText(S.hm.kind.stuck);
  await expect(card.locator(".sentence")).toContainText(VERDICT_REASON.zh);
  // 裁判的建议动作在原因下面一行。
  await expect(card.locator(".stuck-action")).toHaveText(S.hm.stuckAction(VERDICT_ACTION.zh));
  await expect(pageTab(page, S.lay.tabOverview)).toHaveClass(/\battention\b/);
  await shot(page, "live-status-zh.png", "light");
  await shot(page, "live-status-zh-dark.png", "dark");
  await openTab(page, S.lay.tabTickets);
  await expect(row("DMS-1").locator(".who")).toHaveText(S.lay.whoYou);
  await expect(row("DMS-1").locator(".who")).toHaveClass(/\bturn-stuck\b/);
  if (shots) await row("DMS-1").screenshot({ path: join(shots, "live-status-row.png") });

  // 判断用的 prompt 证明这些都是真的读到的：transcript、tasks 目录的输出文件、ps 读到的子进程 CPU（读不到时写的是“未知”）。
  expect(judgePrompts()).toHaveLength(1);
  expect(judgePrompts()[0]).toContain(LONG_COMMAND.slice(0, 40));
  expect(judgePrompts()[0]).toContain(COMMAND_OUTPUT.join("\n"));
  expect(judgePrompts()[0]).toContain("子进程最近几分钟几乎没有用 CPU。");
  // headless 自己的 session 不进“未认领”。
  expect(dbRows(s, "SELECT cwd, dismissed FROM sessions WHERE id LIKE 'judge-%'")).toEqual([{ cwd: worktree, dismissed: 1 }]);

  // 5. 「总控」里终端区至少占窗口一半高，窗口缩到最小也一样；终端能输入，也有回复。
  await openTab(page, S.lay.tabControl);
  await expectTerminalsKeepHalf(page);
  await resizeWindow(app, 900, 600);
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(600);
  await expectTerminalsKeepHalf(page);
  await resizeWindow(app, 1280, 820);
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeGreaterThan(600);
  await typeLine(page, "hello from the control tab");
  await expect.poll(() => terminalText(page)).toContain("收到：hello from the control tab");

  // 6. 在别的页面上，侧栏的 feature 行也是「卡住了」的点。首页有一张 DMS-1「卡住了」的卡片（写着理由）；
  //    feature 总控回完话停在提示符上不算轮到你（第 1 层 c7038adb），所以侧栏的“轮到你”后面是 1。
  await ticketPage("DMS-2");
  await expect(page.locator(".sidebar .feature-group > .feature-row .turn-dot")).toHaveClass(/\bturn-stuck\b/);
  await home();
  await expect(page.getByTestId("turn-card")).toHaveCount(1);
  const need = cardOf("DMS-1");
  await expect(need.locator(".turn-tag")).toHaveText(S.hm.kind.stuck);
  await expect(need.locator(".where .path")).toHaveText("checkout › DMS-1");
  await expect(need.locator(".sentence")).toContainText(VERDICT_REASON.zh);
  await expect(page.locator(".sidebar .nav.home .needs-you-badge")).toHaveText("1");

  // 7. 首页卡片「没事，忽略」（很久没输出判的卡住才有，activity:dismiss）：卡片消失；没有新动静就不再判断、不再提醒。
  await need.getByRole("button", { name: S.hm.act.ignore, exact: true }).click();
  await expect(need).toHaveCount(0);
  await page.waitForTimeout(4 * STUCK_CHECK_MS);
  await expect(need).toHaveCount(0);
  expect(judgePrompts()).toHaveLength(1);
  await featurePage();
  await openTab(page, S.lay.tabOverview);
  await expect(featureCard("DMS-1")).toHaveCount(0);

  // 8. 命令又有输出之后再卡住：再判断一次，卡片又出现。
  appendFileSync(outputFile, "step 9 of 8\n");
  await expect(featureCard("DMS-1")).toHaveAttribute("data-kind", "stuck");
  expect(judgePrompts()).toHaveLength(2);
  expect(judgePrompts()[1]).toContain("step 9 of 8");

  // 9. 还卡着的时候有了新输出：卡片自己消失，不用等下一次判断。之后再卡住一次，给后面的步骤用。
  appendFileSync(outputFile, "step 10 of 8\n");
  await expect(featureCard("DMS-1")).toHaveCount(0);
  await expect(featureCard("DMS-1")).toHaveAttribute("data-kind", "stuck");
  expect(judgePrompts()).toHaveLength(3);

  // 10. 「概况」卡片的「开修复 session」（session:openFix）：落到「总控」，多一个“修复 DMS-1”的 session，切到它的终端。
  await featureCard("DMS-1").getByRole("button", { name: S.hm.act.fix, exact: true }).click();
  await expect(pageTab(page, S.lay.tabControl)).toHaveAttribute("aria-selected", "true");
  const fixButton = page.locator(".feature-page .sessions-bar .session").filter({ hasText: S.fixSessionFor("DMS-1") });
  await expect(fixButton).toHaveClass(/active/);
  const fixId = (await fixButton.getAttribute("title"))!.split("\n")[1];
  expect(fixId).toBeTruthy();
  expect(fixId).not.toBe(coordinatorId);

  // 11. 新 session 收到任务：四条规则、两个 session 的名字（登记文件里查到的）、卡住 session 的资料。
  const fixTranscript = join(s.claudeConfigDir, "projects", workspace.replace(/[^A-Za-z0-9]/g, "-"), `${fixId}.jsonl`);
  const firstMessage = () => {
    if (!existsSync(fixTranscript)) return "";
    const line = readFileSync(fixTranscript, "utf8").split("\n")[0];
    return (JSON.parse(line) as { message: { content: string } }).message.content;
  };
  await expect.poll(firstMessage).toContain("Shipherd 开了这个 session 来解决一个卡住的 session。");
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

  // 12. 不存成总控；原 session 不受影响，还是卡住的。同一个卡住的 session 再点一次，回到同一个修复 session。
  expect(dbRows(s, "SELECT coordinator, fixes_session AS fixes, ticket_key AS ticket FROM sessions WHERE id = ?", fixId)).toEqual([{ coordinator: 0, fixes: stuckId, ticket: null }]);
  await openTab(page, S.lay.tabOverview);
  await expect(featureCard("DMS-1")).toHaveAttribute("data-kind", "stuck");
  await featureCard("DMS-1").getByRole("button", { name: S.hm.act.fix, exact: true }).click();
  await expect(pageTab(page, S.lay.tabControl)).toHaveAttribute("aria-selected", "true");
  await expect(fixButton).toHaveClass(/active/);
  // 数 session（.session-wrap）：session 栏里的「清理闲置」「已隐藏」按钮也带 .session 样式。
  await expect(page.locator(".feature-page .sessions-bar .session-wrap")).toHaveCount(2);

  // 13. 在别的页面上从首页点 DMS-1 卡片的「去看看」：进 DMS-1 的 ticket 页、落在「对话」，看到的是卡住的那个 session（只有它一个，没有切换条）。
  // 再切到「终端」：当前终端是卡住的那个 session。
  await ticketPage("DMS-2");
  await home();
  await cardOf("DMS-1").getByRole("button", { name: S.hm.act.look, exact: true }).click();
  await onTicketPage("DMS-1");
  await expect(pageTab(page, S.lay.tabConversation)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".conv .conv-switch")).toHaveCount(0);
  await expect(page.locator(".conv .feed .msg-u").first()).toContainText("/fake-bash");
  await openTicketTab(page, "terminal");
  await expect(page.locator(".sessions-bar .session.active")).toHaveAttribute("title", new RegExp(`\\n${stuckId}$`));
  // 卡住的 session 的终端：命令还在跑。
  await expect.poll(() => terminalText(page)).toContain("running");

  // 14. 修复 session 比总控新，但 feature 汇总还是 fork 总控：它不会被选成总控。
  await featurePage();
  await openTab(page, S.lay.tabSummary);
  const progress = page.locator(".feature-page .feature-progress");
  await progress.getByRole("button", { name: S.runFeatureSummary, exact: true }).click();
  await expect(progress.getByText(S.featureSummaryStored, { exact: true })).toBeVisible();
  expect(fakeLog()).toContain(`--resume ${coordinatorId} --fork-session`);
  expect(fakeLog()).not.toContain(`--resume ${fixId}`);

  // 15. 卡住的 session 还在被监视时退出：监视先停，数据库才关，日志里没有错误。
  expect(pageErrors).toEqual([]);
  await app.close();
  const log = () => readFileSync(join(s.shipherdHome, "logs", "main.log"), "utf8");
  expect(log()).not.toMatch(/activity tick failed|activity of session|stuck judge/);

  // 16. 重启后是英文：卡住状态不留，DMS-2 新跑的命令重新判断，判断结果和界面都是英文。
  s.lang = "en";
  const E = STRINGS.en;
  const english = await launch(s);
  const en = english.page;
  await en.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-2" }).click();
  await openTab(en, E.lay.tabTerminal);
  await en.getByRole("button", { name: `+ ${E.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(en)).toContain("fake claude ready");
  await typeLine(en, "/fake-bash git push origin feature/checkout");
  await en.locator(".sidebar .ticket.feature").click();
  await openTab(en, E.lay.tabOverview);
  const enFeatureCard = en.locator(".feature-page .scope-you").getByTestId("turn-card").filter({ has: en.locator(".where .key", { hasText: /^DMS-2$/ }) });
  await expect(enFeatureCard.locator(".turn-tag")).toHaveText(E.hm.kind.stuck);
  await expect(enFeatureCard.locator(".sentence")).toContainText(VERDICT_REASON.en);
  await expect(enFeatureCard.locator(".stuck-action")).toHaveText(E.hm.stuckAction(VERDICT_ACTION.en));
  await expect(enFeatureCard.getByRole("button", { name: E.hm.act.fix, exact: true })).toBeVisible();
  await expect(enFeatureCard.getByRole("button", { name: E.hm.act.ignore, exact: true })).toBeVisible();
  await shot(en, "live-status-en.png", "light");
  await shot(en, "live-status-en-dark.png", "dark");
  // 英文的首页：一张 DMS-2 的「卡住了」卡片，写着英文的理由。
  await en.getByRole("button", { name: E.home, exact: true }).click();
  const enCard = en.getByTestId("turn-card").filter({ has: en.locator(".where .path", { hasText: /DMS-2$/ }) });
  await expect(enCard.locator(".turn-tag")).toHaveText(E.hm.kind.stuck);
  await expect(enCard.locator(".sentence")).toContainText(VERDICT_REASON.en);
});

/**
 * 设计文档 2026-10-31：这一轮结束了但后台命令还在跑，session 在等命令，不是等用户：feature「进行中」里是 agent 在干活；
 * 完成通知之后回到“等你回话”（轮到你）。检查间隔保持 3 分钟，这个测试不会走到卡住判断。
 */
test("live status: a background command stays on the row after its turn ends", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { SHIPHERD_ACTIVITY_TICK_MS: "200" };
  const { page } = await launch(s);
  await completeWizard(page, s);
  await createCheckoutFeature(page, s);
  await newFeatureTicket(page, "DMS-1", "frontend");
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, "/fake-bg git push origin feature/checkout");
  await expect.poll(() => terminalText(page)).toContain("收到：/fake-bg git push");

  // 后台命令还在跑：「进行中」里 DMS-1 是 agent 在干活，「全部 ticket」里不是轮到你。
  await page.locator(".sidebar .ticket.feature").click();
  const run = page.locator(".feature-page .home-run").filter({ has: page.locator(".key", { hasText: /^DMS-1$/ }) });
  await openTab(page, S.lay.tabRunning);
  await expect(run.locator(".turn-tag")).toHaveText(S.hm.whoAgent);
  await openTab(page, S.lay.tabTickets);
  await expect(ticketRow(page, "DMS-1").locator(".who")).toHaveText(S.hm.whoAgent);

  // 完成通知之后：停下来等你回话，「进行中」里没有它了，「全部 ticket」里轮到你。
  await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: "DMS-1" }).click();
  await openTicketTab(page, "terminal");
  await typeLine(page, "/fake-bg-done");
  await page.locator(".sidebar .ticket.feature").click();
  await expect(pageTab(page, S.lay.tabTickets)).toHaveAttribute("aria-selected", "true");
  await expect(ticketRow(page, "DMS-1").locator(".who")).toHaveText(S.lay.whoYou);
  await openTab(page, S.lay.tabRunning);
  await expect(run).toHaveCount(0);
});

/**
 * × 杀掉进程：没有 SessionEnd hook，等待标记只能由退出事件清掉。ticket、feature 两层的点都要消失，feature 页这一行也不再等回话。
 * 收起侧栏的 feature 时点还在；正在看的 ticket 留在收起的 feature 下面。
 */
test("ending a waiting session with × clears the mark on the ticket and its feature", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await createCheckoutFeature(page, s);
  await newFeatureTicket(page, "DMS-1", "frontend");
  const featureRow = page.locator(".sidebar .feature-group > .feature-row");
  const sidebarTicket = page.locator(".sidebar .feature-tickets .ticket").filter({ has: page.locator(".key", { hasText: /^DMS-1$/ }) });
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await typeLine(page, "hello");
  await expect.poll(() => terminalText(page)).toContain("收到：hello");
  await expect(sidebarTicket.locator(".turn-dot")).toBeVisible();
  await expect(featureRow.locator(".turn-dot")).toBeVisible();

  // 收起 feature：正在看的 DMS-1 还在下面，feature 行的点还在。
  await featureRow.locator(".twisty").click();
  await expect(page.locator(".sidebar .feature-tickets .ticket .key")).toHaveText(["DMS-1"]);
  await expect(featureRow.locator(".turn-dot")).toBeVisible();
  await featureRow.locator(".twisty").click();

  const end = page.getByTitle(S.endSession, { exact: true });
  await end.click();
  await end.click();
  await expect(end).toHaveCount(0);
  await expect(sidebarTicket.locator(".turn-dot")).toHaveCount(0);
  await expect(featureRow.locator(".turn-dot")).toHaveCount(0);
  // feature 页：DMS-1 不再轮到你，「概况」页签也不标。
  await featureRow.locator(".ticket").click();
  await expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
  await openTab(page, S.lay.tabTickets);
  await expect(ticketRow(page, "DMS-1").locator(".who")).not.toHaveText(S.lay.whoYou);
  await expect(pageTab(page, S.lay.tabOverview)).not.toHaveClass(/\battention\b/);
  expect(dbRows(s, "SELECT COUNT(*) AS n FROM sessions WHERE waiting_for_input = 1")).toEqual([{ n: 0 }]);
});

/**
 * 归档 feature（原来在 epics.spec 里跟着 epic 一起测）：有终端开着时拒绝，什么都不变、错误显示出来；
 * 终端退出后归档，连同它的 ticket，MCP 配置清掉，侧栏和页面都没了；从「已归档」恢复，一起归档的 ticket 回来，总控能再开，配置重新写好。
 */
test("archiving a feature: refused while a terminal is open, then archived with its tickets and restored", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const workspace = join(s.dir, "shop-features", "checkout");
  const mcpFile = join(s.shipherdHome, "mcp", "features", "1.json");
  const { page } = await launch(s);
  await completeWizard(page, s);
  await createCheckoutFeature(page, s);
  await newFeatureTicket(page, "DMS-1", "frontend");
  await page.locator(".sidebar .ticket.feature").click();
  await expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
  await newCoordinator(page);
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  expect(existsSync(mcpFile)).toBe(true);
  const archivedAt = () => dbRows<{ what: string; at: number | null }>(s, "SELECT name AS what, archived_at AS at FROM features UNION ALL SELECT key, archived_at FROM tickets ORDER BY what");
  const archive = page.locator(".feature-page .ticket-header").getByRole("button", { name: S.archiveFeature, exact: true });

  await archive.click();
  await expect(page.locator(".feature-page .error")).toHaveText(S.createErrors.sessions_open);
  await expect(archive).toBeEnabled();
  expect(archivedAt()).toEqual([{ what: "DMS-1", at: null }, { what: "checkout", at: null }]);
  expect(existsSync(mcpFile)).toBe(true);

  await typeLine(page, "exit");
  await expect(page.locator(".terminal-wrap:visible .exited")).toBeVisible();
  await archive.click();
  await expect(page.locator(".feature-page")).toHaveCount(0);
  await expect(page.locator(".sidebar .ticket.feature")).toHaveCount(0);
  await expect(page.locator(".sidebar button.nav.active")).toHaveAccessibleName(S.home);
  expect(archivedAt().every((r) => r.at !== null)).toBe(true);
  expect(existsSync(mcpFile)).toBe(false);

  await openArchived(page);
  await page.locator("table").last().getByRole("button", { name: S.unarchive, exact: true }).click();
  await expect(page.getByRole("heading", { name: "checkout", exact: true })).toBeVisible();
  await expect(page.locator(".sidebar .feature-tickets .ticket .key")).toHaveText(["DMS-1"]);
  expect(archivedAt().every((r) => r.at === null)).toBe(true);
  await newCoordinator(page);
  await expect.poll(() => [...(existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "").matchAll(new RegExp(`interactive new \\S+ mcp=\\S* cwd=${escapeRe(workspace)} `, "g"))].length).toBe(2);
  expect(existsSync(mcpFile)).toBe(true);
});
