import { REASON_LIMIT } from "../src/shared/control";
import { S } from "../src/renderer/src/strings";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { completeWizard, expect, FAKE_GH_ORIGIN, ghCalls, ghReadPr, makeGitRepo, test, newButton, type FakeGhFixture } from "./fixtures";

// BTL-270：ticket 不做了就关掉，和「完成」分开；原因必填，关了以后横幅写着原因，能重新打开。
test("close a ticket with a reason, see why it is closed, then reopen it", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-9");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-9", exact: true })).toBeVisible();

  // 状态下拉框里「已关闭」不能直接选（要原因），「待决定」不出现（只能自动得出）。
  const select = page.locator(".ticket-header select").first();
  await expect(select.locator("option", { hasText: "已关闭" })).toBeDisabled();
  await expect(select.locator("option", { hasText: "待决定" })).toHaveCount(0);

  await page.getByRole("button", { name: S.tc.close, exact: true }).click();
  const dialog = page.locator("form.close-ticket");
  await expect(dialog.getByRole("heading", { name: S.tc.title("E2E-9") })).toBeVisible();
  // 没有开着的 PR：预览里写着没有，也没有公开评论的提示。
  await expect(dialog.getByText(S.tc.prsNone)).toBeVisible();
  await expect(dialog.locator(".close-public-comment")).toHaveCount(0);
  // 原因没填不能关。
  await expect(dialog.getByRole("button", { name: S.tc.confirm, exact: true })).toBeDisabled();
  // 超长的不截断：原文都在框里，提示超了，不让提交。
  const long = "长".repeat(REASON_LIMIT + 1);
  await dialog.getByRole("textbox").fill(long);
  await expect(dialog.getByRole("textbox")).toHaveValue(long);
  await expect(dialog.getByText(S.tc.reasonTooLong(REASON_LIMIT))).toBeVisible();
  await expect(dialog.getByRole("button", { name: S.tc.confirm, exact: true })).toBeDisabled();
  await dialog.getByRole("textbox").fill("需求变了，这个不做了");
  await dialog.getByRole("button", { name: S.tc.confirm, exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.locator(".ticket-closed-banner")).toContainText(S.tc.banner("需求变了，这个不做了"));
  await expect(page.locator(".ticket-closed-banner")).toContainText(S.tc.by.user);
  await expect(select).toHaveValue("closed");

  await page.getByRole("button", { name: S.tc.reopen, exact: true }).click();
  await expect(page.locator(".ticket-closed-banner")).toHaveCount(0);
  await expect(select).toHaveValue("auto");
  await expect(page.getByRole("button", { name: S.tc.close, exact: true })).toBeVisible();
});

// BTL-270：ticket 关上了、但开着的 PR 没关掉时不算完成：对话框留着，列出 PR 和 gh 的错误，能重试剩下的；重试成了才关对话框。
test("when a PR fails to close, the dialog stays open with the reason and retrying closes the rest", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const url = "https://github.com/acme/app/pull/44";
  const fixture = (closeFails: string[]): FakeGhFixture => ({
    closeFails,
    branches: { "feature/E2E-12": [{ number: 44, url, state: "OPEN", headRefName: "feature/E2E-12", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null }] },
    prs: {
      [url]: {
        number: 44, url, state: "OPEN", headRefName: "feature/E2E-12", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null,
        isDraft: false, reviewDecision: "", headRefOid: "eeee5555eeee", author: { login: "dev" }, reviews: [], comments: [], commits: [], statusCheckRollup: [],
        // 关之前实时核对 head（BTL-270 审查）：owner 和 ticket 仓库的一样（不是 fork）、目标分支。
        isCrossRepository: false, headRepositoryOwner: { login: "acme" }, headRepository: { name: "app" }, baseRefName: "main",
      },
    },
  });
  const s = makeSandbox({ gh: fixture(["44"]) });
  const repo = makeGitRepo(join(s.dir, "proj", "app"), FAKE_GH_ORIGIN);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature/E2E-12"]);
  const { page } = await launch(s);
  await completeWizard(page, s);
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-12");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(repo);
  await page.getByRole("radio", { name: S.branch, exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-12", exact: true })).toBeVisible();

  // 等 PR 读过（gh pr view 或批量读跑过、gh 调用停下来），它才是能关的 PR。
  await expect.poll(() => ghReadPr(s, url), { timeout: 60_000 }).toBe(true);
  let last = -1;
  await expect.poll(() => { const n = ghCalls(s).length; const same = n === last; last = n; return same; }, { timeout: 30_000, intervals: [2000] }).toBe(true);

  await page.getByRole("button", { name: S.tc.close, exact: true }).click();
  const dialog = page.locator("form.close-ticket");
  await dialog.getByRole("textbox").fill("换了做法");
  // 预览列出这个 ticket 分支上的 PR，默认不勾；勾了才关，并提示原因会作为评论公开发到 GitHub。
  const pick = dialog.locator("fieldset.close-prs").getByRole("checkbox", { name: url });
  await expect(pick).toBeVisible();
  await expect(pick).not.toBeChecked();
  await expect(dialog.getByText(S.tc.publicComment)).toHaveCount(0);
  await pick.check();
  await expect(dialog.getByText(S.tc.publicComment)).toBeVisible();
  await dialog.getByRole("button", { name: S.tc.confirm, exact: true }).click();

  // ticket 关了，但 PR 没关掉：不显示为完成，对话框换成「没处理完的」，每条都有链接和原因。
  const left = page.locator("form.close-ticket-leftovers");
  await expect(left.getByRole("heading", { name: S.tc.leftTitle("E2E-12") })).toBeVisible();
  await expect(left.getByText(S.tc.leftPrs(1))).toBeVisible();
  await expect(left.locator(".close-leftovers li")).toHaveCount(1);
  await expect(left.locator(".close-leftovers li")).toContainText(url);
  await expect(left.locator(".close-leftovers li")).toContainText(S.tc.prKind.failed);
  await expect(left.locator(".close-leftovers li")).toContainText("could not close pull request #44");
  await expect(page.locator(".ticket-closed-banner")).toContainText(S.tc.banner("换了做法"));

  // 还是关不掉：重试后照样列着。
  await left.getByRole("button", { name: S.tc.retry, exact: true }).click();
  await expect.poll(() => ghCalls(s).filter((a) => a[0] === "pr" && a[1] === "close").length).toBe(2);
  await expect(left.locator(".close-leftovers li")).toContainText("could not close pull request #44");

  // gh 好了：重试只关这一个，成了才关对话框。
  s.setGh(fixture([]));
  await left.getByRole("button", { name: S.tc.retry, exact: true }).click();
  await expect(page.locator("form.close-ticket")).toHaveCount(0);
  const closes = ghCalls(s).filter((a) => a[0] === "pr" && a[1] === "close");
  expect(closes).toHaveLength(3);
  expect(closes.every((a) => a[2] === "44")).toBe(true);
});

// BTL-270 审查（建议 1）：关 ticket 时没勾的 PR 还开着，ticket 页上有「关掉剩下的 PR」：同一个勾选框，评论写关闭时的原因。
test("a closed ticket with an open PR of its own offers to close the remaining PRs with the same checkboxes", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const url = "https://github.com/acme/app/pull/45";
  const s = makeSandbox({ gh: {
    branches: { "feature/E2E-13": [{ number: 45, url, state: "OPEN", headRefName: "feature/E2E-13", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null }] },
    prs: {
      [url]: {
        number: 45, url, state: "OPEN", headRefName: "feature/E2E-13", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null,
        isDraft: false, reviewDecision: "", headRefOid: "ffff6666ffff", author: { login: "dev" }, reviews: [], comments: [], commits: [], statusCheckRollup: [],
        isCrossRepository: false, headRepositoryOwner: { login: "acme" }, headRepository: { name: "app" }, baseRefName: "main",
      },
    },
  } });
  const repo = makeGitRepo(join(s.dir, "proj", "app"), FAKE_GH_ORIGIN);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature/E2E-13"]);
  const { page } = await launch(s);
  await completeWizard(page, s);
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-13");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(repo);
  await page.getByRole("radio", { name: S.branch, exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-13", exact: true })).toBeVisible();
  await expect.poll(() => ghReadPr(s, url), { timeout: 60_000 }).toBe(true);
  let last = -1;
  await expect.poll(() => { const n = ghCalls(s).length; const same = n === last; last = n; return same; }, { timeout: 30_000, intervals: [2000] }).toBe(true);

  // 关 ticket，PR 不勾：关上了，PR 还开着。
  await expect(page.locator(".ticket-close-rest")).toHaveCount(0);
  await page.getByRole("button", { name: S.tc.close, exact: true }).click();
  const dialog = page.locator("form.close-ticket");
  await dialog.getByRole("textbox").fill("先不做了");
  await expect(dialog.locator("fieldset.close-prs").getByRole("checkbox", { name: url })).toBeVisible();
  await dialog.getByRole("button", { name: S.tc.confirm, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(ghCalls(s).filter((a) => a[0] === "pr" && a[1] === "close")).toHaveLength(0);

  // 「关掉剩下的 PR」：没有原因框，写着关闭时的原因；不勾不能提交，勾了才关。
  await page.getByRole("button", { name: S.tc.closeRest, exact: true }).click();
  const rest = page.locator("form.close-ticket-rest");
  await expect(rest.getByRole("heading", { name: S.tc.restTitle("E2E-13") })).toBeVisible();
  await expect(rest.getByRole("textbox")).toHaveCount(0);
  await expect(rest.locator(".close-rest-reason")).toContainText("先不做了");
  await expect(rest.getByRole("button", { name: S.tc.restConfirm, exact: true })).toBeDisabled();
  await rest.locator("fieldset.close-prs").getByRole("checkbox", { name: url }).check();
  await rest.getByRole("button", { name: S.tc.restConfirm, exact: true }).click();
  await expect(page.locator("form.close-ticket")).toHaveCount(0);
  const closes = ghCalls(s).filter((a) => a[0] === "pr" && a[1] === "close");
  expect(closes).toHaveLength(1);
  expect(closes[0][2]).toBe("45");
  // 评论用的是关闭时的原因；ticket 还是关着，原因没变。
  expect(closes[0].join(" ")).toContain("先不做了");
  await expect(page.locator(".ticket-closed-banner")).toContainText(S.tc.banner("先不做了"));
});

// BTL-270 审查（第二轮）：打开关闭框以后 ticket 被别人先关了（这里在页面里直接调关闭，代替总控）：提交时提示，只关勾的 PR，评论用框里填的原因。
test("closing from the dialog after someone else closed the ticket closes only the ticked PRs, with the reason typed, and says so", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const url = "https://github.com/acme/app/pull/46";
  const s = makeSandbox({ gh: {
    branches: { "feature/E2E-14": [{ number: 46, url, state: "OPEN", headRefName: "feature/E2E-14", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null }] },
    prs: {
      [url]: {
        number: 46, url, state: "OPEN", headRefName: "feature/E2E-14", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null,
        isDraft: false, reviewDecision: "", headRefOid: "abab7777abab", author: { login: "dev" }, reviews: [], comments: [], commits: [], statusCheckRollup: [],
        isCrossRepository: false, headRepositoryOwner: { login: "acme" }, headRepository: { name: "app" }, baseRefName: "main",
      },
    },
  } });
  const repo = makeGitRepo(join(s.dir, "proj", "app"), FAKE_GH_ORIGIN);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature/E2E-14"]);
  const { page } = await launch(s);
  await completeWizard(page, s);
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-14");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(repo);
  await page.getByRole("radio", { name: S.branch, exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-14", exact: true })).toBeVisible();
  await expect.poll(() => ghReadPr(s, url), { timeout: 60_000 }).toBe(true);
  let last = -1;
  await expect.poll(() => { const n = ghCalls(s).length; const same = n === last; last = n; return same; }, { timeout: 30_000, intervals: [2000] }).toBe(true);

  await page.getByRole("button", { name: S.tc.close, exact: true }).click();
  const dialog = page.locator("form.close-ticket");
  await dialog.getByRole("textbox").fill("我这边也不做了");
  await dialog.locator("fieldset.close-prs").getByRole("checkbox", { name: url }).check();
  // 框开着的时候，别人先把 ticket 关了（不关 PR）。
  await page.evaluate(() => (window as unknown as { shipherd: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }).shipherd.invoke("tickets:close", "E2E-14", { reason: "别人先关了", closePrs: false, endSessions: false }));
  await expect(page.locator(".ticket-closed-banner")).toContainText(S.tc.banner("别人先关了"));
  await dialog.getByRole("button", { name: S.tc.confirm, exact: true }).click();
  await expect(page.locator("form.close-ticket")).toHaveCount(0);
  await expect(page.getByText(S.tc.closedMeanwhile.prs)).toBeVisible();
  const closes = ghCalls(s).filter((a) => a[0] === "pr" && a[1] === "close");
  expect(closes).toHaveLength(1);
  expect(closes[0][2]).toBe("46");
  expect(closes[0].join(" ")).toContain("我这边也不做了");
  // 关闭的原因还是先关的那次。
  await expect(page.locator(".ticket-closed-banner")).toContainText(S.tc.banner("别人先关了"));
});

// BTL-270 审查（第三轮）：打开关闭框以后 ticket 被别人先关了，这次什么都没勾：不报「已经关了」的错，提示刚被关了、没有要再做的。
test("submitting the close dialog with nothing ticked after someone else closed the ticket just says so, without an error", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  const { page } = await launch(s);
  await completeWizard(page, s);
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-15");
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-15", exact: true })).toBeVisible();

  await page.getByRole("button", { name: S.tc.close, exact: true }).click();
  const dialog = page.locator("form.close-ticket");
  await dialog.getByRole("textbox").fill("我这边也不做了");
  await page.evaluate(() => (window as unknown as { shipherd: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }).shipherd.invoke("tickets:close", "E2E-15", { reason: "别人先关了", closePrs: false, endSessions: false }));
  await expect(page.locator(".ticket-closed-banner")).toContainText(S.tc.banner("别人先关了"));
  await dialog.getByRole("button", { name: S.tc.confirm, exact: true }).click();
  await expect(page.locator("form.close-ticket")).toHaveCount(0);
  await expect(page.getByText(S.tc.closedMeanwhile.nothing)).toBeVisible();
  await expect(page.locator(".ticket-closed-banner")).toContainText(S.tc.banner("别人先关了"));
});
