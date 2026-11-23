import type { ElectronApplication, Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { STRINGS, type UiStrings } from "../../src/renderer/src/strings";
import { create, expect, makeGitRepo, newButton, openTab, ROOT, sandboxEnv, type FakeGhFixture, type PrViewFixture, type Sandbox, test } from "../fixtures";
import { assertFfmpeg, caption, demoClick, hideOverlay, installOverlay, Recorder } from "./capture";
import { allTickets, ASKING_TICKET, DEMO, type DemoData, type DemoLang, fakeClaudeScript, ORG, PR_NUMBER, PR_TICKET, REPOS, STARTED, WORKING_TICKET } from "./demo-data";

/**
 * 录 README 用的动图和截图（BTL-251）：`pnpm demo:record`。不是测试，不进 CI，见 docs/demo-media.md。
 * 和 e2e 一样在沙盒里跑：假 claude（按 demo-data.ts 的剧本说话）、假 gh（PR #42）、临时的 HOME 和数据目录，
 * 碰不到真的 ~/.shipherd 和 ~/.claude。epic 总控拆活、开 session 这几步由这里扮演总控，经 shipherd-sessions MCP 调用。
 * 产物写到 docs/media/（设了 SHIPHERD_DEMO_OUT 就写到那里）。
 */

const OUT = process.env.SHIPHERD_DEMO_OUT ?? join(ROOT, "docs", "media");
/** 文件名后缀：英文没有，中文是 .zh-CN（和 README.zh-CN.md 一样）。 */
const SUFFIX: Record<DemoLang, string> = { en: "", zh: ".zh-CN" };
const GIF_LIMIT = 5 * 1024 * 1024;

type McpServerConfig = { command: string; args: string[]; env: Record<string, string> };
type ToolReply = { content: { text: string }[]; isError?: boolean };

/** 以 from 这个 session 的身份连上 shipherd-sessions（stdio），像总控那样调用工具。环境和 Shipherd 一样是沙盒的。 */
async function sessionsServer(s: Sandbox, server: McpServerConfig, from: string) {
  const child = spawn(server.command, server.args, { env: { ...sandboxEnv(s), ...server.env, SHIPHERD_SESSION: from }, stdio: ["pipe", "pipe", "inherit"] });
  const replies = createInterface({ input: child.stdout });
  let next = 0;
  const send = (method: string, params: object) => new Promise<ToolReply>((resolve) => {
    const id = ++next;
    const onLine = (l: string) => {
      let msg: { id?: number; result: ToolReply };
      try {
        msg = JSON.parse(l) as typeof msg;
      } catch {
        return; // 不是 JSON-RPC 的输出行，跳过。
      }
      if (msg.id !== id) return;
      replies.off("line", onLine);
      resolve(msg.result);
    };
    replies.on("line", onLine);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  return {
    async call(name: string, args: object): Promise<string> {
      const r = await send("tools/call", { name, arguments: args });
      if (r.isError) throw new Error(`${name} failed: ${r.content[0]?.text}`);
      return r.content[0]?.text ?? "";
    },
    close: () => child.kill(),
  };
}

/** 假 gh：FERN-101 的分支上有 PR #42，approved、CI 绿、可以合；merged 为真时它已经合进去了。 */
function ghFixture(d: DemoData, merged: boolean): FakeGhFixture {
  const url = `https://github.com/${ORG}/web/pull/${PR_NUMBER}`;
  const list = {
    number: PR_NUMBER, url, state: merged ? ("MERGED" as const) : ("OPEN" as const), headRefName: `feature/${PR_TICKET}`,
    createdAt: "2026-11-20T08:00:00Z", mergedAt: merged ? "2026-11-20T09:30:00Z" : null, closedAt: merged ? "2026-11-20T09:30:00Z" : null,
  };
  const view: PrViewFixture = {
    ...list, isDraft: false, reviewDecision: "APPROVED", headRefOid: "c0ffee42", author: { login: "you" }, reviews: [], comments: [], commits: [],
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    title: d.prTitle, baseRefName: "main", labels: [], reviewRequests: [], mergeable: merged ? "UNKNOWN" : "MERGEABLE", mergeStateStatus: merged ? "UNKNOWN" : "CLEAN",
  };
  return { branches: { [`feature/${PR_TICKET}`]: [list] }, prs: { [url]: view } };
}

/** 首次使用向导：填假 claude、装 hooks，然后一路「下一步」到「完成」（步数以后变了也不用改这里）。 */
async function completeWizard(page: Page, s: Sandbox, T: UiStrings): Promise<void> {
  await expect(page.getByTestId("wizard")).toBeVisible();
  await page.getByPlaceholder(T.generalPlaceholders.claudePath, { exact: true }).fill(s.claudePath);
  await page.getByRole("button", { name: T.save, exact: true }).click();
  const next = page.getByRole("button", { name: T.wizardNext, exact: true });
  await expect(next).toBeEnabled();
  await next.click();
  // hook 还没装时主按钮是「安装并继续」（BTL-249 改的）。
  await page.getByRole("button", { name: T.wizardHooksInstallNext, exact: true }).click();
  const finish = page.getByRole("button", { name: T.wizardFinish, exact: true });
  await expect(next.or(finish).first()).toBeVisible();
  while (!(await finish.isVisible())) {
    await next.click();
    await page.waitForTimeout(100);
  }
  await finish.click();
  await expect(page.getByTestId("wizard")).toHaveCount(0);
}

const fakeLog = (s: Sandbox) => (existsSync(s.fakeLog) ? readFileSync(s.fakeLog, "utf8") : "");

async function record(lang: DemoLang, app: ElectronApplication, page: Page, s: Sandbox): Promise<void> {
  const d = DEMO[lang];
  const T = STRINGS[lang];
  const file = (name: string, ext: string) => join(OUT, `${name}${SUFFIX[lang]}.${ext}`);
  const still = async (name: string) => {
    await hideOverlay(page);
    await page.screenshot({ path: file(name, "png") });
  };
  // 截图里不要窗口外的东西：固定窗口大小，浅色主题；「打开 PR」不真的开浏览器。
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 768));
  await page.emulateMedia({ colorScheme: "light" });
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {};
  });
  await completeWizard(page, s, T);

  // 两个仓库放在沙盒 HOME 的 code/<ORG> 下：页头显示成 ~/code/<ORG>-features/...。
  const home = join(s.dir, "home");
  const root = join(home, "code", ORG);
  for (const r of REPOS) makeGitRepo(join(root, r), `https://github.com/${ORG}/${r}.git`);
  await installOverlay(page, home);
  await create(page, await newButton(page, "newFeature", T), T.featureName, d.epic, root, T);
  await openTab(page, T.lay.tabControl);
  await page.locator(".feature-page").getByRole("button", { name: `+ ${T.newCoordinator}`, exact: true }).click();
  await expect.poll(() => fakeLog(s)).toContain("mcp=shipherd-workspace,shipherd-feature,shipherd-sessions");
  const coordinatorId = /interactive new (\S+) mcp=shipherd-workspace,shipherd-feature,shipherd-sessions/.exec(fakeLog(s))![1];
  const terminal = page.locator(".terminal-wrap:visible .xterm");
  await expect(terminal).toContainText(d.coordinatorBanner);

  const rec = new Recorder(page, join(s.dir, "frames"));
  // 1. 把 epic 讲给总控。
  rec.resume();
  await caption(page, d.captions.describe);
  await rec.hold(600);
  await demoClick(page, terminal);
  await page.keyboard.type(d.description, { delay: 18 });
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText(d.coordinatorReply);
  await rec.hold(1500);

  // 2. 总控拆成 feature 和 ticket：在「概况」里一块块长出来。
  const config = JSON.parse(readFileSync(join(s.shipherdHome, "mcp", "features", "1.json"), "utf8")) as { mcpServers: Record<string, McpServerConfig> };
  const mcp = await sessionsServer(s, config.mcpServers["shipherd-sessions"], coordinatorId);
  try {
    await caption(page, d.captions.split);
    await demoClick(page, page.getByRole("tab", { name: T.lay.tabOverview, exact: true }));
    for (const f of d.features) {
      await mcp.call("create_feature", { name: f.name });
      await rec.hold(250);
    }
    for (const t of allTickets(d)) {
      await mcp.call("create_ticket", { ticket: t.key, title: t.title, repos: [t.repo], feature: t.feature });
      await rec.hold(350);
    }
    await expect(page.locator(".sidebar .feature-tickets .ticket")).toHaveCount(allTickets(d).length);
    await rec.hold(1000);

    // 3. 每个 ticket 一个 session：前三个开工。
    // session 刚开、任务还没送到时会短暂显示「停下了、在等你」：开 session 这段不录，等它们真的干起活来、FERN-103 问完再接着录。
    await caption(page, d.captions.sessions);
    await rec.hold(800);
    await rec.pause(200);
    const sessionOf: Record<string, string> = {};
    for (const key of STARTED) {
      sessionOf[key] = (JSON.parse(await mcp.call("start_session", { ticket: key, task: d.tasks[key] })) as { sessionId: string }).sessionId;
    }
    const row = (key: string) => page.locator(".feature-page .ticket-table tbody tr").filter({ hasText: key });
    await expect(row(WORKING_TICKET).locator(".who")).toHaveText(T.hm.whoAgent, { timeout: 60_000 });
    await expect(page.getByTestId("turn-card").filter({ hasText: d.question })).toHaveCount(1, { timeout: 60_000 });
    rec.resume();
    await rec.hold(2500);
    await rec.pause();

    // 等 FERN-103 问完、PR watcher 读到 #42（15 秒一轮）：这段不录。
    await page.locator(".sidebar").getByRole("button", { name: T.home, exact: true }).click();
    const cards = page.getByTestId("turn-card");
    const question = cards.filter({ hasText: d.question });
    const merge = cards.filter({ hasText: PR_TICKET });
    await expect(question).toHaveCount(1, { timeout: 60_000 });
    await expect(merge).toHaveCount(1, { timeout: 60_000 });
    await page.waitForTimeout(1000);

    // 静态截图：轮到你、epic 页、ticket 页。
    await still("your-turn");
    await page.locator(".sidebar .ticket.feature").filter({ hasText: d.epic }).click();
    await openTab(page, T.lay.tabOverview);
    await page.waitForTimeout(800);
    await still("epic");
    await page.locator(".sidebar .feature-tickets .ticket").filter({ hasText: PR_TICKET }).click();
    await expect(page.getByRole("heading", { name: new RegExp(`^${PR_TICKET}`) })).toBeVisible();
    await page.waitForTimeout(800);
    await still("ticket");

    // 4. 轮到你：回到首页，回答 FERN-103 的问题。
    await page.locator(".sidebar").getByRole("button", { name: T.home, exact: true }).click();
    await expect(question).toHaveCount(1);
    rec.resume();
    await caption(page, d.captions.yourTurn);
    await rec.hold(1800);
    await demoClick(page, question.getByRole("button", { name: d.options[0], exact: true }));
    await expect(question).toContainText(T.hm.act.answered(d.options[0]));
    await rec.hold(1200);

    // 5. 合并由你来点：「打开 PR」去 GitHub 合（这里不开浏览器，改假 gh 让它变成已合并）。
    await caption(page, d.captions.merge);
    await rec.hold(800);
    await demoClick(page, merge.getByRole("button", { name: T.hm.act.openPr, exact: true }));
    await rec.hold(1000);
    await rec.pause();
    // 合进去以后总控通知 FERN-101；它回完话停下，Shipherd 马上重查这个 ticket 的 PR（不然要等 5 分钟一轮）。
    s.setGh(ghFixture(d, true));
    await mcp.call("send_message", { session: sessionOf[PR_TICKET], text: d.mergedNote });
    await expect(merge).toHaveCount(0, { timeout: 60_000 });
    await page.locator(".sidebar .ticket.feature").filter({ hasText: d.epic }).click();
    await openTab(page, T.lay.tabOverview);
    await page.waitForTimeout(800);
    rec.resume();
    await caption(page, d.captions.merged);
    await rec.hold(1500);
    await rec.pause(2000);
  } finally {
    mcp.close();
  }

  // 先拼到沙盒里，大小合格才放进 docs/media，超了不留下半成品。
  const gif = file("demo", "gif");
  const draft = join(s.dir, "demo.gif");
  rec.encode(draft);
  const size = statSync(draft).size;
  console.log(`${gif}: ${(size / 1024 / 1024).toFixed(2)} MB, ${rec.frames().length} frames`);
  expect(size, "the GIF should stay under 5 MB for the README").toBeLessThan(GIF_LIMIT);
  copyFileSync(draft, gif);
  expect(fakeLog(s), `${ASKING_TICKET} asked its question`).toContain("ask_user");
}

for (const lang of ["en", "zh"] as const) {
  test(`record the README demo (${lang})`, async ({ makeSandbox, launch }) => {
    test.skip(process.platform === "win32", "the fake gh is an sh wrapper; record on macOS or Linux");
    assertFfmpeg();
    mkdirSync(OUT, { recursive: true });
    const s = makeSandbox({ gh: ghFixture(DEMO[lang], false) });
    s.lang = lang;
    const script = join(s.dir, "fake-claude-script.json");
    writeFileSync(script, JSON.stringify(fakeClaudeScript(DEMO[lang])));
    // 活动每半秒推一次：session 的状态点和工具调用跟得上画面。
    s.env = { FAKE_CLAUDE_SCRIPT: script, SHIPHERD_ACTIVITY_TICK_MS: "500" };
    const { app, page } = await launch(s);
    await record(lang, app, page, s);
  });
}
