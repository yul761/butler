import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { S } from "../src/renderer/src/strings";
import { completeWizard, expect, FAKE_GH_ORIGIN, newButton, openSettingsGroup, type Sandbox, terminalText, test, openTicketTab } from "./fixtures";

/** 沙盒的 Claude Code 记录里放几次在这个仓库里跑过的命令：只读的跑够次数，写的也跑了（不能成为候选）。 */
function seedHistory(s: Sandbox): void {
  const dir = join(s.claudeConfigDir, "projects", "-seeded-history");
  mkdirSync(dir, { recursive: true });
  let seq = 0;
  const session = (id: string, commands: string[]) =>
    writeFileSync(
      join(dir, `${id}.jsonl`),
      commands
        .flatMap((command) => {
          const tid = `toolu_${++seq}`;
          return [
            JSON.stringify({ cwd: s.repo, sessionId: id, message: { content: [{ type: "tool_use", id: tid, name: "Bash", input: { command } }] } }),
            JSON.stringify({ cwd: s.repo, sessionId: id, message: { content: [{ type: "tool_result", tool_use_id: tid, content: "ok" }] } }),
          ];
        })
        .join("\n") + "\n",
    );
  session("hist-1", ["gh pr view 1", "gh pr view 2", "git push", "git push"]);
  session("hist-2", ["gh pr view 3", "git push origin main", "rm -rf build", "rm -rf build"]);
}

/**
 * ws-j 权限档案：候选来自本机的历史，在设置 →「打断与通知」里确认一次（BTL-249 起不在第一次的向导里），
 * 之后这个仓库的 Shipherd session 的 --settings 里就放行它；写操作（push、rm）跑得再多也不会出现，更不会进 --settings。
 */
test("the permission profile offers read-only commands from history and confirmed ones reach the session's --settings", async ({ makeSandbox, launch }) => {
  const s = makeSandbox();
  execFileSync("git", ["remote", "add", "origin", FAKE_GH_ORIGIN], { cwd: s.repo, stdio: "ignore" });
  execFileSync("git", ["config", "protocol.https.allow", "never"], { cwd: s.repo, stdio: "ignore" });
  seedHistory(s);
  const { page } = await launch(s);
  const fakeLog = () => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");

  // 1. 走完向导，到设置 →「打断与通知」看权限档案的候选。
  await completeWizard(page, s);
  await openSettingsGroup(page, "interrupts");
  const step = page.getByTestId("profile-candidates");

  // 2. 候选：只有只读的 gh pr view；push 和 rm 不在里面。默认勾上了。
  const repo = step.getByTestId("profile-repo-acme/app");
  await expect(repo.getByText("Bash(gh pr view:*)", { exact: true })).toBeVisible();
  await expect(repo.getByTestId("profile-pick-Bash(gh pr view:*)")).toBeChecked();
  await expect(step).not.toContainText("push");
  await expect(step).not.toContainText("rm ");
  await step.getByTestId("profile-confirm-acme/app").click();
  await expect(page.getByText(S.ij.noCandidates, { exact: true })).toBeVisible();

  // 3. 同一页上能看到这条确认过的规则；webhook 默认没设置，推送开关关着。
  const rule = page.getByTestId("profile-rule-Bash(gh pr view:*)");
  await expect(rule).toContainText("acme/app");
  await expect(rule).toContainText(S.ij.statusLabel.confirmed);
  await expect(page.getByTestId("notify-switch")).toHaveText(S.ij.notifySwitchOff);
  await expect(page.getByTestId("webhook-saved")).toHaveCount(0);
  await expect(page.getByTestId("notify-test")).toBeDisabled();

  // 4. 在这个仓库开 session：--settings 里放行了 gh pr view，没有任何写操作。
  await (await newButton(page, "newTicket")).click();
  await page.getByLabel(S.ticketKey, { exact: true }).fill("PERM-1");
  await page.getByRole("button", { name: S.create, exact: true }).click();
  await expect(page.getByRole("heading", { name: "PERM-1", exact: true })).toBeVisible();
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.addRepo}`, exact: true }).click();
  await page.getByRole("textbox", { name: `${S.repo} ${S.pick}`, exact: true }).fill(s.repo);
  await page.getByRole("radio", { name: S.branch, exact: true }).check();
  await page.getByRole("button", { name: S.add, exact: true }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await openTicketTab(page, "terminal");
  await page.getByRole("button", { name: `+ ${S.newSession}`, exact: true }).click();
  await page.getByRole("button", { name: S.switchAndOpen, exact: true }).click();
  await expect.poll(() => terminalText(page)).toContain("fake claude ready");
  await expect.poll(fakeLog).toContain(`cwd=${s.repo} adddirs= guide=`);
  const sid = new RegExp(`interactive new (\\S+) mcp=\\S* cwd=${s.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `).exec(fakeLog())![1];
  const line = new RegExp(`interactive-allow ${sid} (.+)`).exec(fakeLog());
  const allow = JSON.parse(line![1]!) as string[];
  expect(allow).toContain("Bash(gh pr view:*)");
  expect(allow.filter((r) => /push|rm |Edit|Write/.test(r))).toEqual([]);
});
