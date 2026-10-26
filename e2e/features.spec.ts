import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, terminalText, test } from "./fixtures";

/**
 * 设计文档 2026-10-26（feature）：选上一层目录建 feature（勾两个仓库）→ 在 feature 下建前端、后端两个 ticket，worktree 出现在工作区里
 * → feature 总控在工作区里打开 → 按 mcp 配置启动 butler-sessions，start_session 给前端 ticket 开子 session
 * → 子 session 退出后 handoff 报告 PR 已合并 → 前端 ticket 的 worktree 被自动清理。
 */
test("a feature over a parent directory: tickets' worktrees in its workspace, a coordinator, cleanup after merge", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  const workspace = join(s.dir, "shop-features", "checkout");
  const feWorktree = join(workspace, "frontend-dms-1");
  const beWorktree = join(workspace, "backend-dms-2");
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  const { page } = await launch(s);
  await completeWizard(page, s);

  // 1. 新建 feature：选上一层目录，下一层的两个仓库默认都勾上。
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

  // 2. feature 下建两个 ticket：前端一个、后端一个。worktree 放在工作区里。
  const newTicket = async (key: string, repo: string) => {
    await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
    await page.getByLabel(S.ticketKey, { exact: true }).fill(key);
    for (const name of ["frontend", "backend"]) {
      const box = page.locator(".modal").getByRole("checkbox", { name, exact: true });
      if (name === repo) await box.check();
      else await box.uncheck();
    }
    await page.getByRole("button", { name: S.create, exact: true }).click();
    await expect(page.getByRole("heading", { name: key, exact: true })).toBeVisible();
  };
  await newTicket("DMS-1", "frontend");
  expect(existsSync(join(feWorktree, "README.md"))).toBe(true);
  await page.locator(".feature-link").getByRole("button", { name: "checkout", exact: true }).click();
  await newTicket("DMS-2", "backend");
  expect(existsSync(join(beWorktree, "README.md"))).toBe(true);

  // 侧栏：feature 下面缩进列着它的两个 ticket，不在按状态分组的列表里。
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
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
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
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("plan the api");
  await page.keyboard.press("Enter");
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
