import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test } from "./fixtures";

/**
 * 设计文档 2026-10-23（多仓库 ticket）：不带仓库建 ticket → 添加两个仓库 → 各自开 session → 总控看得到两个仓库（第一步）
 * → 总控的 butler-sessions MCP server 开一个子 session，任务被输进去（第二步）。假 claude 不会调用 MCP 工具，
 * 所以这里按 mcp 配置文件里的命令直接启动那个 server，像 claude 一样经 stdio 调用它。
 */
test("a ticket over two repos: a session per repo and a coordinator that sees both", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
  await completeWizard(page, s);

  // 1. 不填仓库建 ticket：只能开总控。
  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("FULL-1");
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "FULL-1", exact: true })).toBeVisible();
  await expect(page.getByText(S.noRepos, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `+ ${S.newSession}`, exact: true })).toHaveCount(0);

  // 2. 添加两个仓库：前端用 worktree，后端用分支。
  const addRepo = async (path: string, mode: string) => {
    await page.getByRole("button", { name: `+ ${S.addRepo}`, exact: true }).click();
    await page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true }).fill(path);
    await page.getByRole("radio", { name: mode, exact: true }).check();
    await page.getByRole("button", { name: S.add, exact: true }).click();
    await expect(page.locator(".modal")).toHaveCount(0);
  };
  await addRepo(s.repo, S.worktree);
  await addRepo(s.apiRepo, S.branch);
  await expect(page.locator(".repos-bar .repo .name")).toHaveText(["repo", "api"]);

  // 3. 在 api 仓库开 session（分支模式：先切到 ticket 的分支），session 按钮上标着仓库名。
  await page.getByRole("combobox", { name: S.pickRepo }).selectOption({ label: "api" });
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await page.getByRole("button", { name: S.switchAndOpen, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await expect.poll(fakeLog).toContain(`cwd=${s.apiRepo} adddirs=\n`);
  await expect(page.locator(".sessions-bar .session .place")).toHaveText(["api"]);

  // 4. 总控：在工作区目录里，两个仓库都用 --add-dir 加进去。
  await page.getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  const worktree = join(`${s.repo}-worktrees`, "FULL-1");
  const workspace = join(s.butlerHome, "workspaces", "FULL-1");
  await expect.poll(fakeLog).toContain(`cwd=${workspace} adddirs=${worktree}|${s.apiRepo}\n`);
  await expect(page.locator(".sessions-bar .session .place")).toHaveText([S.coordinator, "api"]);

  // 5. 总控的 mcp 配置里有 butler-sessions（普通 session 的没有）；按配置启动它，调用 start_session。
  await expect.poll(fakeLog).toMatch(/mcp=[^\n]*butler-sessions[^\n]*cwd=/);
  const config = JSON.parse(readFileSync(join(s.butlerHome, "mcp", "tickets", "coordinator", "FULL-1.json"), "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const server = config.mcpServers["butler-sessions"];
  // claude 会把自己的环境变量（包括 Butler 给的 BUTLER_SESSION）传给 MCP server：这里按总控的 session id 补上。
  const coordinatorId = /interactive new (\S+) mcp=[^\n]*butler-sessions/.exec(fakeLog())![1];
  const child = spawn(server.command, server.args, {
    env: { ...server.env, BUTLER_SESSION: coordinatorId, PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    const replies = createInterface({ input: child.stdout });
    const next = () => new Promise<{ id: number; result: { content: { text: string }[]; isError?: boolean } }>((r) => replies.once("line", (l) => r(JSON.parse(l))));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } })}\n`);
    await next();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "start_session", arguments: { repo: "repo", task: "boss-says-build-the-ui" } } })}\n`);
    const reply = await next();
    expect(reply.result.isError).toBeUndefined();
    const started = JSON.parse(reply.result.content[0].text) as { sessionId: string; repo: string };
    expect(started.repo).toBe("repo");

    // 子 session 出现在同一个 ticket 下，开在 repo 的 worktree 里，任务作为第一条消息提交。
    await expect.poll(fakeLog).toContain(`interactive new ${started.sessionId} mcp=butler-memory,butler-workspace cwd=${worktree} adddirs=\n`);
    const childButton = page.locator(".sessions-bar .session").filter({ has: page.locator(`[title="${S.spawnedByCoordinator}"]`) });
    await expect(childButton).toBeVisible();
    await expect(childButton).toHaveAttribute("title", /^总控 session 交给你的任务：\nboss-says-build-the-ui\n/);
    await expect(childButton.locator(".place")).toHaveText("repo");
    await childButton.click();
    // 任务带着固定的开头、作为一条消息提交（多行粘贴没有被逐行回车）。
    await expect.poll(() => terminalText(page)).toContain("收到：总控 session 交给你的任务：");
    await expect.poll(() => terminalText(page)).toContain("boss-says-build-the-ui");
    expect(await terminalText(page)).not.toContain("收到：boss-says-build-the-ui");
  } finally {
    child.kill();
  }
});
