import type { Page } from "@playwright/test";
import { IPC } from "../src/shared/ipc";
import type { TurnBoard } from "../src/shared/turn";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, terminalText, test, unsupportedGhCalls } from "./fixtures";

const board = (page: Page, filter?: unknown) =>
  page.evaluate(
    ([ch, f]) =>
      (window as unknown as { butler: { invoke(c: string, ...a: unknown[]): Promise<{ ok: boolean; value: TurnBoard }> } }).butler.invoke(ch as string, f ?? null),
    [IPC.turnBoard, filter] as const,
  );

/**
 * 第 1 层：「请你 review」的 PR 经 gh search prs 进 turn:board，不属于任何 ticket；带 filter 时不出现。
 * Windows 上跳过：假 gh 是 sh 包装，resolveGh 只认 gh.exe。
 */
test("a PR someone asked you to review shows up on the turn board", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const url = "https://github.com/other/lib/pull/77";
  const s = makeSandbox({
    gh: {
      branches: {}, prs: {},
      reviewRequested: [{ number: 77, title: "Fix parser", url, repository: { nameWithOwner: "other/lib" }, author: { login: "amy" }, updatedAt: "2026-11-19T00:00:00Z" }],
    },
  });
  const { page } = await launch(s);
  await completeWizard(page, s);
  await expect.poll(async () => (await board(page)).value.items.find((i) => i.turn.kind === "review")?.pr?.url, { timeout: 20_000 }).toBe(url);
  const b = (await board(page)).value;
  const review = b.items.find((i) => i.turn.kind === "review")!;
  expect(review).toMatchObject({ ticketKey: null, featureId: null, turn: { owner: "you", kind: "review", author: "amy", title: "Fix parser", url } });
  expect(b.counts.you).toBe(b.items.filter((i) => i.turn.owner === "you").length);
  expect((await board(page, { ticketKey: "E2E-7" })).value.items.some((i) => i.turn.kind === "review")).toBe(false);
  expect(unsupportedGhCalls(s)).toEqual([]);
});

/** Butler 总控撞了用量上限：turn:board 里有一条不属于 ticket 的 you/butler session_limited（首页的「Butler 要你点一下」）。 */
test("the Butler session hitting its usage limit is on the turn board", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  s.env = { BUTLER_ACTIVITY_TICK_MS: "200" };
  const { page } = await launch(s);
  await completeWizard(page, s);
  await page.locator(".sidebar").getByRole("button", { name: S.butlerNav, exact: true }).click();
  await page.locator(".butler-page").getByRole("button", { name: `+ ${S.newButlerSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await page.locator(".terminal-wrap:visible .xterm").click();
  await page.keyboard.type("/fake-limit You've hit your limit · resets 3pm (UTC)");
  await page.keyboard.press("Enter");
  await expect.poll(() => terminalText(page)).toContain("hit your limit");
  const limited = async () => (await board(page)).value.items.find((i) => i.turn.kind === "butler" && i.turn.notice.kind === "session_limited");
  await expect.poll(async () => (await limited())?.turn, { timeout: 20_000 }).toMatchObject({
    owner: "you", kind: "butler", notice: { kind: "session_limited", target: { page: "butler" }, limit: { kind: "usage_limit" } },
  });
  expect(await limited()).toMatchObject({ ticketKey: null, pr: null });
});
