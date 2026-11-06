import { describe, expect, it } from "vitest";
import type { FeatureHandoff, Handoff } from "../../shared/handoff";
import { runHeadless } from "../claude/headless";
import { locateClaude, readLoginShellPath } from "../claude/locate";
import { EpicHistoryRepo } from "../db/epic-history-repo";
import { EpicsRepo } from "../db/epics-repo";
import { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import { FeaturesRepo } from "../db/features-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { EPIC_DIGEST_MAX_DECISIONS, EPIC_DIGEST_SUMMARY_CHARS, EpicDigestRunner } from "../epics/epic-digest";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import { setLang } from "../i18n";
import { memDb, tempDir } from "../test-utils";
import { judgeNeedsYou } from "./needs-you";

/**
 * 只在 BUTLER_LIVE_CLAUDE=1 时运行：真的调用本机已登录的 claude（会花一点公司额度）。
 * 验证两处无头调用在真实 CLI 上能拿到符合 schema 的结构化结果：needs-you 判断（Haiku）和 epic 整理（Sonnet）。
 */
describe.skipIf(process.env.BUTLER_LIVE_CLAUDE !== "1")("headless judges against the real claude", () => {
  async function deps(): Promise<HeadlessExecDeps> {
    const pathValue = await readLoginShellPath(process.platform, process.env);
    const claudePath = locateClaude({ override: "", pathValue, platform: process.platform });
    expect(claudePath).not.toBeNull();
    return {
      run: runHeadless,
      ready: async () => undefined,
      claude: () => ({ path: claudePath, pathValue }),
      // BUTLER_HOME 指向临时目录：用户级 butler-hook 的上报只会落进临时 inbox。
      baseEnv: { ...process.env, BUTLER_HOME: tempDir("butler-home-") },
      sessions: { recordHeadless: () => undefined } as never,
      now: () => Date.now(),
      newRunId: () => "live-judges",
      log: (m, e) => console.log("[live log]", m, e ?? ""),
    };
  }

  it("needs-you judge tells a question from a status report", async () => {
    const d = await deps();
    const cwd = tempDir("butler-cwd-");
    try {
      const ask = await judgeNeedsYou(d, "要把它拆成两个 PR 吗？", cwd);
      const done = await judgeNeedsYou(d, "已经推上去了，CI 在跑。", cwd);
      setLang("en");
      const askEn = await judgeNeedsYou(d, "Both approaches work. Should I go with Postgres or SQLite for the cache?", cwd);
      console.log("[live verdicts]", JSON.stringify({ ask, done, askEn }));
      expect(ask?.needsYou).toBe(true);
      expect(ask?.reason.length).toBeGreaterThan(0);
      expect(done?.needsYou).toBe(false);
      expect(askEn?.needsYou).toBe(true);
    } finally {
      setLang("zh");
    }
  }, 240_000);

  it("epic digest writes a bounded epic_history row", async () => {
    const d = await deps();
    const db = memDb();
    const epics = new EpicsRepo(db);
    const features = new FeaturesRepo(db);
    const tickets = new TicketsRepo(db);
    const handoffs = new HandoffsRepo(db);
    const featureHandoffs = new FeatureHandoffsRepo(db);
    const history = new EpicHistoryRepo(db);
    const now = Date.now();
    const epicId = epics.insert({ name: "商城", workspaceDir: "/e/shop", createdAt: now - 3 * 86_400_000 });
    const featureId = features.insert({ name: "结账", workspaceDir: "/w/checkout", createdAt: now - 3 * 86_400_000, epicId });
    tickets.insert({ key: "SHOP-1", title: null, status: "active", statusManual: null, createdAt: now - 3 * 86_400_000, archivedAt: null, featureId });
    const summary: FeatureHandoff = {
      summary: "结账流程的下单和支付已经联调完成，退款接口还没开始。", blockers: [], next_steps: [{ ticket: "SHOP-1", text: "开始退款接口" }],
      decisions: [{ key: "money", statement: "金额一律用整数分存储" }], open_questions: [],
    };
    featureHandoffs.insert({ featureId, sessionId: null, trigger: "nightly", createdAt: now - 2 * 86_400_000, payload: summary, rawText: null });
    const ticket: Handoff = {
      ticket: "SHOP-1", status: "active", done_today: [], next_steps: [], blockers: [], prs: [], jira: null, followups: [],
      decisions: [{ key: "gateway", statement: "支付网关选 Stripe，因为团队已有账号且支持分期" }],
      learnings: ["Stripe webhook 要校验签名，否则会被重放"], open_questions: [],
    };
    handoffs.insert({ ticketKey: "SHOP-1", sessionId: null, trigger: "nightly", createdAt: now - 86_400_000, payload: ticket, rawText: null });

    const runner = new EpicDigestRunner({
      ...d, history, epics, features, featureHandoffs, handoffs, tickets,
      memory: { setEpicDigestNote: async () => undefined },
      cwd: () => tempDir("butler-cwd-"),
    });
    await runner.weekly();
    const rows = history.list(epicId, 10);
    console.log("[live digest]", JSON.stringify(rows));
    expect(rows).toHaveLength(1);
    const { summary: text, decisions } = rows[0].payload;
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(EPIC_DIGEST_SUMMARY_CHARS);
    expect(decisions.length).toBeLessThanOrEqual(EPIC_DIGEST_MAX_DECISIONS);
    for (const x of decisions) {
      expect(x.what.length).toBeGreaterThan(0);
      expect(x.why.length).toBeGreaterThan(0);
    }
  }, 300_000);
});
