import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { M } from "../src/main/strings";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, FAKE_GH_ORIGIN, ghCalls, makeGitRepo, terminalText, test, unsupportedGhCalls, type FakeGhFixture, newButton, openTicketTab } from "./fixtures";

const url = "https://github.com/acme/app/pull/43";
const SHA = "dddd4444dddd";
const fixture: FakeGhFixture = {
  branches: { "feature/E2E-10": [{ number: 43, url, state: "OPEN", headRefName: "feature/E2E-10", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null }] },
  prs: {
    [url]: {
      number: 43, url, state: "OPEN", headRefName: "feature/E2E-10", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null,
      isDraft: false, reviewDecision: "", headRefOid: SHA, author: { login: "dev" }, reviews: [], comments: [], commits: [],
      statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/app/actions/runs/78/job/1" }],
    },
  },
  runs: {
    "78": {
      attempt: 1, status: "completed", conclusion: "failure",
      jobs: [{ name: "test", status: "completed", conclusion: "failure", startedAt: "2026-11-18T08:00:00Z", completedAt: "2026-11-18T08:03:00Z", steps: [{ name: "Install dependencies", conclusion: "failure", number: 3 }] }],
    },
  },
  logs: { "78": "npm ERR! network request to https://registry.npmjs.org/left-pad failed, reason: connect ETIMEDOUT 104.16.0.35:443" },
  threads: {
    "43": [{
      id: "PRRT_2", isResolved: false, isOutdated: false, path: "src/a.ts", line: 3, originalLine: 3,
      comments: {
        nodes: [{
          databaseId: 601, author: { __typename: "Bot", login: "Copilot" }, body: "Prefer a const here.\n```suggestion\nconst total = 1;\n```",
          createdAt: "2026-11-18T08:05:00Z", url: `${url}#discussion_r601`, path: "src/a.ts", line: 3, originalLine: 3, commit: { oid: SHA },
        }],
      },
    }],
  },
};

/** 会在 GitHub 上留下东西的 gh 调用（改 PR、开 PR、重跑 CI、回复评论、resolve、贴 issue、建 label）。 */
function writes(calls: string[][]): string[][] {
  const readPr = new Set(["view", "list", "diff", "checks", "status"]);
  return calls.filter((a) =>
    (a[0] === "pr" && !readPr.has(a[1] ?? "")) ||
    (a[0] === "run" && a[1] === "rerun") ||
    (a[0] === "issue" && a[1] !== "view" && a[1] !== "list") ||
    a[0] === "label" ||
    (a[0] === "api" && a.some((x) => x.startsWith("body=") || /\bmutation\b/.test(x))),
  );
}

/**
 * 工作流 R（总设计第 8 节）：全新安装、什么设置都不改，行为和 2.1.0 一样。一个开着的 PR，CI 因为网络超时挂了，
 * 上面还有一条 Copilot 的行内评论：CI 失败照 2.1.0 送进 session；不重跑 CI，评论不送进 session、不回复、不 resolve，
 * 不改 PR、不贴任何东西，审计页的「对外动作」一节是空的。
 * Windows 上跳过：假 gh 是 sh 包装，resolveGh 只认 gh.exe（Windows 上「对外动作默认全关」由 progress.spec.ts 覆盖）。
 */
test("a fresh install that changes no settings behaves like 2.1.0 and leaves nothing on GitHub", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const s = makeSandbox({ gh: fixture });
  const repo = makeGitRepo(join(s.dir, "proj", "app"), FAKE_GH_ORIGIN);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature/E2E-10"]);

  const { page } = await launch(s);
  await completeWizard(page, s);

  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-10");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(repo);
  await page.getByRole("radio", { name: S.branch, exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-10", exact: true })).toBeVisible();
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");

  // 2.1.0 的行为：CI 失败直接送进 session（没有分类，也不重跑）。
  const failedHead = M().ciFailedNotice(M().ciWherePr(43), SHA.slice(0, 7), [{ name: "test" }]).split("\n")[0];
  const failed = failedHead.slice(failedHead.indexOf("PR #43"), failedHead.indexOf(SHA.slice(0, 7)));
  await expect.poll(() => terminalText(page), { timeout: 90_000 }).toContain(failed);

  // 评论循环和 CI 分诊都挂在同一轮 PR 读取上（onPrRead），通知送到时它们已经跑过；再等 gh 调用停下来（连续两次采样不变），
  // 自动的东西要做早就做了。失败的 PR 每 5 分钟才再读一次，不等下一轮。
  let last = -1;
  await expect.poll(() => { const n = ghCalls(s).length; const same = n === last; last = n; return same; }, { timeout: 30_000, intervals: [2000] }).toBe(true);
  expect(ghCalls(s).some((a) => a[0] === "run" && a[1] === "view" && a.includes("--log-failed"))).toBe(true);

  expect(await terminalText(page)).not.toContain("Prefer a const here.");
  expect(writes(ghCalls(s))).toEqual([]);
  expect(unsupportedGhCalls(s)).toEqual([]);

  await page.locator(".sidebar").getByRole("button", { name: S.audit, exact: true }).click();
  await expect(page.getByTestId("external-audit")).toContainText(S.externalAuditNone);
});
