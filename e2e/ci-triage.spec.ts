import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { M } from "../src/main/strings";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, FAKE_GH_ORIGIN, ghCalls, makeGitRepo, setLoopPolicy, terminalText, test, unsupportedGhCalls, type FakeGhFixture } from "./fixtures";

const url = "https://github.com/acme/app/pull/42";
const SHA = "cccc3333cccc";
const job = (conclusion: string) => ({
  name: "test", status: "completed", conclusion, startedAt: "2026-11-18T08:00:00Z", completedAt: "2026-11-18T08:03:00Z",
  steps: [{ name: "Install dependencies", conclusion, number: 3 }],
});
const fixture = (passed: boolean): FakeGhFixture => ({
  branches: { "feature/E2E-9": [{ number: 42, url, state: "OPEN", headRefName: "feature/E2E-9", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null }] },
  prs: {
    [url]: {
      number: 42, url, state: "OPEN", headRefName: "feature/E2E-9", createdAt: "2026-11-18T08:00:00Z", mergedAt: null, closedAt: null,
      isDraft: false, reviewDecision: "", headRefOid: SHA, author: { login: "dev" }, reviews: [], comments: [], commits: [],
      statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: passed ? "SUCCESS" : "FAILURE", detailsUrl: "https://github.com/acme/app/actions/runs/77/job/1" }],
    },
  },
  runs: { "77": { attempt: passed ? 2 : 1, status: "completed", conclusion: passed ? "success" : "failure", jobs: [job(passed ? "success" : "failure")] } },
  logs: { "77": "npm ERR! network request to https://registry.npmjs.org/left-pad failed, reason: connect ETIMEDOUT 104.16.0.35:443" },
});

/**
 * 工作流 I 验收：CI 失败在装依赖那一步、日志是网络超时 → 规则判成环境问题，以 gh run rerun --failed 重跑（开关开着），
 * 不打扰 session；重跑通过后只送「CI 通过」。走真实的路径：PrWatcher → CiDelivery → CiTriage → 假 gh。
 * Windows 上跳过：假 gh 是 sh 包装，resolveGh 只认 gh.exe。
 */
test("a network timeout in CI is rerun and passes without the failure reaching the session", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const s = makeSandbox({ gh: fixture(false) });
  const repo = makeGitRepo(join(s.dir, "proj", "app"), FAKE_GH_ORIGIN);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "feature/E2E-9"]);

  const { page } = await launch(s);
  await completeWizard(page, s);
  await setLoopPolicy(page, { "ci.enabled": "true" }, ["ci_rerun"]);

  await page.getByRole("button", { name: `+ ${S.newTicket}`, exact: true }).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("E2E-9");
  await page.getByRole("textbox", { name: `${S.repoOptional} ${S.pick}`, exact: true }).fill(repo);
  await page.getByRole("radio", { name: S.branch, exact: true }).check();
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E-9", exact: true })).toBeVisible();
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");

  const reran = (): boolean => ghCalls(s).some((a) => a[0] === "run" && a[1] === "rerun" && a[2] === "77" && a.includes("--failed"));
  await expect.poll(reran, { timeout: 90_000 }).toBe(true);
  // 失败没有送进 session。
  const failedHead = M().ciFailedNotice(M().ciWherePr(42), SHA.slice(0, 7), [{ name: "test" }]).split("\n")[0];
  const failed = failedHead.slice(failedHead.indexOf("PR #42"), failedHead.indexOf(SHA.slice(0, 7)));
  expect(await terminalText(page)).not.toContain(failed);

  // 重跑通过：下一轮读到 CI 通过，送「CI 通过」。
  s.setGh(fixture(true));
  const passed = M().ciPassedNotice(M().ciWherePr(42), SHA.slice(0, 7));
  await expect.poll(() => terminalText(page), { timeout: 90_000 }).toContain(passed.slice(passed.indexOf("PR #42"), passed.indexOf(SHA.slice(0, 7)) + 7));
  expect(await terminalText(page)).not.toContain(failed);
  expect(ghCalls(s).filter((a) => a[0] === "run" && a[1] === "rerun")).toHaveLength(1);
  expect(unsupportedGhCalls(s)).toEqual([]);
});
