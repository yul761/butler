import type { Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, makeGitRepo, newButton, openSettingsTab, openTab, openTicketTab, terminalText, test, type Sandbox } from "./fixtures";

/**
 * BTL-256：总控给关着的 session 发消息时，Shipherd 在后台接着原来的对话恢复它再送；内存不够时排着；
 * 用户点 × 结束的，总控在那之后发来消息也恢复（BTL-279「关了的就打开」）；
 * 打开「重启后自动恢复」时，Shipherd 重启后把上次开着终端的、总控管的 session 恢复回来。
 */

type McpServerConfig = { command: string; args: string[]; env: Record<string, string> };
type ToolReply = { content: { text: string }[]; isError?: boolean };

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");
const sessionsIn = (s: Sandbox, cwd: string) => [...fakeLog(s).matchAll(new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${escapeRe(cwd)} `, "g"))].map((m) => m[1]);
const resumes = (s: Sandbox, id: string) => [...fakeLog(s).matchAll(new RegExp(`interactive resume ${escapeRe(id)} `, "g"))].length;

/** 一个目录里每个 session（transcript 文件名）收到的用户输入。 */
function messagesIn(s: Sandbox, cwd: string): Record<string, string[]> {
  const dir = join(s.claudeConfigDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const entries = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; message: { content: unknown } });
      return [f.replace(/\.jsonl$/, ""), entries.filter((e) => e.type === "user" && typeof e.message.content === "string").map((e) => e.message.content as string)];
    }),
  );
}

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

const json = <T,>(r: ToolReply): T => {
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text) as T;
};

/** 建 epic「payment」（shop/frontend、shop/backend），下面一个只用 frontend 的 ticket PAY-1，再开 epic 总控。返回总控的 session id 和它的 shipherd-sessions。 */
async function epicWithCoordinator(page: Page, s: Sandbox) {
  const shop = join(s.dir, "shop");
  makeGitRepo(join(shop, "frontend"));
  makeGitRepo(join(shop, "backend"));
  await (await newButton(page, "newFeature")).click();
  await page.getByLabel(S.featureName, { exact: true }).fill("payment");
  const box = page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true });
  await box.fill(shop);
  await box.blur();
  await expect(page.getByText(S.subReposFound(2), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "payment", exact: true })).toBeVisible();
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("PAY-1");
  await page.locator(".modal").getByRole("checkbox", { name: "backend", exact: true }).uncheck();
  await page.locator(".modal").getByRole("checkbox", { name: "frontend", exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "PAY-1", exact: true })).toBeVisible();
  await page.locator(".feature-link").getByRole("button", { name: "payment", exact: true }).click();
  await openTab(page, S.lay.tabControl);
  await page.locator(".feature-page").getByRole("button", { name: `+ ${S.newCoordinator}`, exact: true }).click();
  const workspace = join(s.dir, "shop-features", "payment");
  await expect.poll(() => sessionsIn(s, workspace).length).toBe(1);
  const [coordinator] = sessionsIn(s, workspace);
  await expect.poll(() => terminalText(page)).toContain(`fake claude ready (${coordinator.slice(0, 8)})`);
  const config = JSON.parse(readFileSync(join(s.shipherdHome, "mcp", "features", "1.json"), "utf8")) as { mcpServers: Record<string, McpServerConfig> };
  const boss = await sessionsServer(config.mcpServers["shipherd-sessions"], coordinator);
  return { boss, coordinator, workspace, worktree: join(workspace, "frontend-pay-1") };
}

/** 总控给 PAY-1 开一个子 session，等它做完第一件事停下来。 */
async function startChild(boss: Awaited<ReturnType<typeof epicWithCoordinator>>["boss"], s: Sandbox, worktree: string, task: string): Promise<string> {
  const { sessionId } = json<{ sessionId: string }>(await boss.call("start_session", { ticket: "PAY-1", task }));
  await expect.poll(() => (messagesIn(s, worktree)[sessionId] ?? []).join("\n"), { timeout: 30_000 }).toContain(task);
  const waiting = async () => json<{ id: string; waitingForInput: boolean }[]>(await boss.call("list_sessions")).find((r) => r.id === sessionId)?.waitingForInput;
  await expect.poll(waiting, { timeout: 30_000 }).toBe(true);
  return sessionId;
}

const wakeOf = async (boss: Awaited<ReturnType<typeof epicWithCoordinator>>["boss"], id: string) =>
  json<{ id: string; wake?: string }[]>(await boss.call("list_sessions")).find((r) => r.id === id)?.wake;

test("a coordinator's message resumes a closed session in the background once, and waits when memory is short", async ({ makeSandbox, launch }) => {
  test.setTimeout(240_000);
  const s = makeSandbox();
  s.env = { SHIPHERD_ACTIVITY_TICK_MS: "200", SHIPHERD_GATE_TYPING_QUIET_MS: "1000" };
  const { page } = await launch(s);
  await completeWizard(page, s);
  const { boss, coordinator, workspace, worktree } = await epicWithCoordinator(page, s);
  try {
    const child = await startChild(boss, s, worktree, "build-the-form");
    // 总控结束它（不算用户结束）：终端关了，之后有消息照样能恢复。
    expect(json(await boss.call("end_session", { session: child, reason: "done for now" }))).toEqual({ ended: true });
    await expect.poll(() => wakeOf(boss, child)).toBe("resumes");

    // 一下子来两条：只恢复一次，两条都送到。
    const first = json<{ state: string; wake: string; note: string }>(await boss.call("send_message", { session: child, text: "表单用 v2 接口" }));
    expect(first).toMatchObject({ state: "closed", wake: "resuming" });
    const second = json<{ state: string; wake?: string }>(await boss.call("send_message", { session: child, text: "金额用分" }));
    expect(["resuming", undefined]).toContain(second.wake);
    const childGot = () => (messagesIn(s, worktree)[child] ?? []).join("\n");
    await expect.poll(childGot, { timeout: 60_000 }).toContain("表单用 v2 接口");
    await expect.poll(childGot, { timeout: 30_000 }).toContain("金额用分");
    expect(resumes(s, child)).toBe(1);
    // 发送方收到一条回执。
    await expect.poll(() => (messagesIn(s, workspace)[coordinator] ?? []).join("\n"), { timeout: 30_000 }).toContain("【回执】");
    await expect.poll(() => wakeOf(boss, child)).toBe("running");

    // 再结束它，这次内存不够：不恢复，消息排着，返回值说在等内存。
    await expect.poll(async () => (json<{ id: string; waitingForInput: boolean }[]>(await boss.call("list_sessions")).find((r) => r.id === child)?.waitingForInput), { timeout: 30_000 }).toBe(true);
    expect(json(await boss.call("end_session", { session: child, reason: "again" }))).toEqual({ ended: true });
    await expect.poll(() => wakeOf(boss, child)).toBe("resumes");
    const db = new DatabaseSync(join(s.shipherdHome, "app.db"));
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sessionMemoryReserveMb', '1048576')").run();
    db.close();
    const short = json<{ wake: string; wakeError: string }>(await boss.call("send_message", { session: child, text: "等内存" }));
    expect(short.wake).toBe("waiting_memory");
    expect(short.wakeError).toBeTruthy();
    await page.waitForTimeout(1500);
    expect(resumes(s, child)).toBe(1);
    expect(childGot()).not.toContain("等内存");
    expect(await wakeOf(boss, child)).toBe("waiting_memory");
  } finally {
    boss.close();
  }
});

test("a session the user ended with × is resumed in the background when its coordinator sends to it afterwards (BTL-279, was BTL-256)", async ({ makeSandbox, launch }) => {
  test.setTimeout(180_000);
  const s = makeSandbox();
  s.env = { SHIPHERD_ACTIVITY_TICK_MS: "200", SHIPHERD_GATE_TYPING_QUIET_MS: "1000" };
  const { page } = await launch(s);
  await completeWizard(page, s);
  const { boss, worktree } = await epicWithCoordinator(page, s);
  try {
    const child = await startChild(boss, s, worktree, "build-the-form");
    await page.locator(".sidebar .ticket .key").getByText("PAY-1", { exact: true }).click();
    await openTicketTab(page, "terminal");
    const end = page.getByTitle(S.endSession, { exact: true });
    await end.click();
    await end.click();
    await expect(end).toHaveCount(0);
    // 总控看到的是「发一条会怎样」：会恢复。
    await expect.poll(() => wakeOf(boss, child)).toBe("resumes");
    const sent = json<{ state: string; wake: string; note: string }>(await boss.call("send_message", { session: child, text: "接着做" }));
    expect(sent).toMatchObject({ state: "closed", wake: "resuming" });
    await expect.poll(() => (messagesIn(s, worktree)[child] ?? []).join("\n"), { timeout: 60_000 }).toContain("接着做");
    expect(resumes(s, child)).toBe(1);
  } finally {
    boss.close();
  }
});

test("with the setting on, a restart resumes the managed sessions that were open", async ({ makeSandbox, launch }) => {
  test.setTimeout(240_000);
  const s = makeSandbox();
  s.env = { SHIPHERD_ACTIVITY_TICK_MS: "200", SHIPHERD_GATE_TYPING_QUIET_MS: "1000" };
  const first = await launch(s);
  await completeWizard(first.page, s);
  await openSettingsTab(first.page, "basic");
  const toggle = first.page.getByTestId("setting-autoResumeAfterRestart");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  const { boss, coordinator, worktree } = await epicWithCoordinator(first.page, s);
  // 总控说过一句话（一句话都没有的空 session 启动时会被清掉，没什么可恢复的）。
  await first.page.locator(".terminal-wrap:visible .xterm").click();
  await first.page.keyboard.type("plan-the-epic");
  await first.page.keyboard.press("Enter");
  await expect.poll(() => terminalText(first.page)).toContain("plan-the-epic");
  let child: string;
  try {
    child = await startChild(boss, s, worktree, "build-the-form");
  } finally {
    boss.close();
  }
  await first.app.close();
  expect(resumes(s, child)).toBe(0);

  const second = await launch(s);
  // 子 session 和 epic 总控都接着原来的对话在后台恢复回来，不用点开。
  await expect.poll(() => resumes(s, child), { timeout: 60_000 }).toBe(1);
  await expect.poll(() => resumes(s, coordinator), { timeout: 60_000 }).toBe(1);
  await second.page.waitForTimeout(1000);
  expect(resumes(s, child)).toBe(1);
});
