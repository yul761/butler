import { afterEach, describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { NowRow, NowView, UsageSummary, WatchedPr } from "../../shared/types";
import { groupSummary, needsYouText, prPill, rowPlace, rowText, usageDetails, usageLine } from "./now-view";
import { S, setUiLang } from "./strings";

const NOW = 1_000_000_000_000;
const MIN = 60_000;

const act = (over: Partial<SessionActivity> = {}): SessionActivity => ({
  sessionId: "s1", kind: "edit", detail: "notify.ts", background: false, startedAt: NOW - 3 * MIN, lastOutputAt: null,
  stuck: null, reason: null, action: null, lastOutput: [], ...over,
});

const pr = (over: Partial<WatchedPr> = {}): WatchedPr => ({
  ticketKey: "BTL-1", repoId: 1, repoPath: "/r", branch: "b", number: 212, url: "https://github.com/o/r/pull/212",
  state: "open", review: "pending", ci: "passing", headSha: null, checkedAt: NOW, ...over,
});

const row = (over: Partial<NowRow> = {}): NowRow => ({
  sessionId: "s1", ticketKey: "BTL-1", title: "通知中心", repo: null, coordinator: false, activity: act(), mergeQueued: false,
  needsYou: null, refreshing: null, prs: [], idle: false, since: NOW - 3 * MIN, target: { page: "ticket", key: "BTL-1", sessionId: "s1" }, ...over,
});

const usage = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  sinceMs: 0, totalTokens: 12_345_678, cacheReadShare: 0.661, over200kShare: 0.63,
  byKind: { ticket: 0.5, coordinator: 0.3, subagent: 0.15, headless: 0.05 }, byModel: { "claude-haiku": 0.1, "claude-opus": 0.9 }, ...over,
});

afterEach(() => setUiLang("zh"));

describe("rowText", () => {
  it("needs-you rows read 等你 with the reason", () => {
    const r = rowText(row({ needsYou: "问要不要拆 PR", activity: act({ kind: "waiting" }) }), S, NOW);
    expect(r).toMatchObject({ main: "等你：问要不要拆 PR", tone: "danger" });
  });

  it("stuck rows read 卡住 with the reason, or 卡住了 when there is none", () => {
    expect(rowText(row({ needsYou: "测试 20 分钟没有输出", activity: act({ kind: "test", stuck: true }) }), S, NOW)).toMatchObject({ main: "卡住：测试 20 分钟没有输出", tone: "danger" });
    expect(rowText(row({ needsYou: "", activity: act({ kind: "test", stuck: true }) }), S, NOW)).toMatchObject({ main: "卡住了", tone: "danger" });
  });

  it("rows without a session read from their PR and CI", () => {
    const bare = (prs: WatchedPr[]) => rowText(row({ sessionId: null, activity: null, since: null, prs }), S, NOW);
    expect(bare([pr({ ci: "failing" })])).toEqual({ main: "CI 失败", sub: null, tone: "danger" });
    expect(bare([pr({ ci: "pending" })])).toEqual({ main: "等 CI", sub: null, tone: "warn" });
    expect(bare([pr({ review: "pending" })])).toEqual({ main: "等 review", sub: null, tone: "muted" });
    expect(bare([pr({ review: "changes_requested" })])).toEqual({ main: "要修改", sub: null, tone: "muted" });
    expect(bare([pr({ review: "approved" })])).toEqual({ main: "已批准", sub: null, tone: "muted" });
  });

  it("a refreshing row reads 换新中 / Refreshing (plan 16)", () => {
    for (const step of ["handoff", "clear", "resume"] as const) {
      expect(rowText(row({ refreshing: step, activity: act({ kind: "thinking" }) }), S, NOW)).toEqual({ main: "换新中", sub: null, tone: "warn" });
      expect(rowText(row({ refreshing: step, mergeQueued: true, activity: act({ kind: "test", stuck: true }) }), S, NOW).main).toBe("换新中");
    }
    // Butler 的 /handoff 停在权限确认上：显示确认，不显示换新中。
    expect(rowText(row({ refreshing: "handoff", needsYou: "等你确认", activity: act({ kind: "approval" }) }), S, NOW)).toMatchObject({ main: "等你：等你确认", tone: "danger" });
    setUiLang("en");
    expect(rowText(row({ refreshing: "clear" }), S, NOW).main).toBe("Refreshing");
  });

  it("a session being closed for idling reads 闲置，正在关闭 / Idle, closing (BTL-190)", () => {
    expect(rowText(row({ refreshing: "close", activity: act({ kind: "thinking" }) }), S, NOW)).toEqual({ main: "闲置，正在关闭", sub: null, tone: "warn" });
    setUiLang("en");
    expect(rowText(row({ refreshing: "close" }), S, NOW).main).toBe("Idle, closing");
  });

  it("merge queue beats the plain activity", () => {
    expect(rowText(row({ mergeQueued: true, activity: act({ kind: "rebase", detail: null }) }), S, NOW)).toMatchObject({ main: "合并排队", tone: "warn" });
    expect(rowText(row({ mergeQueued: true, needsYou: "问要不要拆 PR" }), S, NOW).main).toBe("等你：问要不要拆 PR");
  });

  it("reads the plain activity, and a stopped session as stopped", () => {
    expect(rowText(row(), S, NOW)).toEqual({ main: "写代码", sub: "notify.ts · 3 分钟", tone: "ok" });
    expect(rowText(row({ activity: act({ kind: "waiting" }), idle: true }), S, NOW)).toEqual({ main: "已停下", sub: null, tone: "muted" });
    expect(rowText(row({ activity: null, idle: true }), S, NOW)).toEqual({ main: "已停下", sub: null, tone: "muted" });
  });

  it("works in English", () => {
    setUiLang("en");
    expect(rowText(row({ needsYou: "split the PR?" }), S, NOW).main).toBe("Waiting on you: split the PR?");
    expect(rowText(row({ needsYou: "", activity: act({ stuck: true }) }), S, NOW).main).toBe("stuck");
  });
});

describe("needsYouText", () => {
  it("is the reason, or the stuck label for a stuck row", () => {
    expect(needsYouText(row({ needsYou: "问要不要拆 PR" }), S)).toBe("问要不要拆 PR");
    expect(needsYouText(row({ needsYou: "测试没有输出", activity: act({ stuck: true }) }), S)).toBe("卡住：测试没有输出");
    expect(needsYouText(row({ needsYou: "", activity: act({ stuck: true }) }), S)).toBe("卡住了");
  });
});

describe("prPill", () => {
  it("colours a failing CI like requested changes and a running one like pending", () => {
    expect(prPill(pr({ ci: "failing", review: "approved" }), S)).toEqual({ text: "PR #212 CI 失败", tone: "changes" });
    expect(prPill(pr({ ci: "pending" }), S)).toEqual({ text: "PR #212 CI 跑中", tone: "pending" });
  });

  it("otherwise follows the PR state and review", () => {
    expect(prPill(pr({ state: "merged" }), S)).toEqual({ text: "PR #212 已合并", tone: "merged" });
    expect(prPill(pr({ review: "approved" }), S)).toEqual({ text: "PR #212 已 approve", tone: "approved" });
    expect(prPill(pr({ review: "changes_requested" }), S)).toEqual({ text: "PR #212 要改", tone: "changes" });
    expect(prPill(pr({ review: null }), S)).toEqual({ text: "PR #212 待 review", tone: "pending" });
  });

  it("says the PR status is unavailable when gh could not read a branch with no PR seen yet (I6)", () => {
    expect(prPill(pr({ state: null, number: null, url: null, ci: "unknown" }), S)).toEqual({ text: "PR 状态不可用", tone: "none" });
    setUiLang("en");
    expect(prPill(pr({ state: null, number: null, url: null, ci: "unknown" }), S)).toEqual({ text: "PR status unavailable", tone: "none" });
    setUiLang("zh");
    // 见过 PR 的：gh 这一次没查成，照旧显示上次的状态。
    expect(prPill(pr({ ci: "unknown" }), S)).toEqual({ text: "PR #212 待 review", tone: "pending" });
  });

  it("shows nothing for a branch with no PR or a closed one", () => {
    expect(prPill(pr({ state: null, number: null, url: null }), S)).toBeNull();
    expect(prPill(pr({ state: "closed" }), S)).toBeNull();
  });
});

describe("groupSummary", () => {
  it("groupSummary skips zero counts", () => {
    expect(groupSummary({ active: 3, needsYou: 1, stuck: 0 }, S)).toBe("3 个进行中 · 1 需要你");
    expect(groupSummary({ active: 2, needsYou: 0, stuck: 1 }, S)).toBe("2 个进行中 · 1 卡住");
    expect(groupSummary({ active: 0, needsYou: 0, stuck: 0 }, S)).toBe("无进行中");
  });
});

describe("usageLine", () => {
  it("usageLine formats tokens and shares", () => {
    expect(usageLine(usage(), S)).toBe("近 7 天：12.3M token · 缓存读取占 66% · 上下文超过 20 万的轮次占 63%");
    expect(usageLine(usage({ totalTokens: 45_600, cacheReadShare: 0, over200kShare: 0 }), S)).toBe("近 7 天：45.6K token · 缓存读取占 0% · 上下文超过 20 万的轮次占 0%");
    expect(usageLine(usage({ totalTokens: 999 }), S)).toMatch(/^近 7 天：999 token/);
  });

  it("lists the kinds in a fixed order and the models largest first", () => {
    expect(usageDetails(usage(), S)).toEqual({
      byKind: ["ticket session 50%", "总控 30%", "子 agent 15%", "后台任务 5%"],
      byModel: ["claude-opus 90%", "claude-haiku 10%"],
    });
  });
});

describe("rowPlace", () => {
  it("names the ticket or 总控 and the feature or epic the row sits in", () => {
    const ticket = row();
    const coord = row({ sessionId: "c1", ticketKey: null, title: null, coordinator: true, target: { page: "feature", id: 7, sessionId: "c1" } });
    const epicRow = row({ sessionId: "e1", ticketKey: null, title: null, coordinator: true, target: { page: "epic", id: 3, sessionId: "e1" } });
    const loose = row({ sessionId: "s9", ticketKey: "BTL-9", title: "独立的 ticket" });
    const counts = { active: 1, needsYou: 0, stuck: 0 };
    const view: NowView = {
      needsYou: [], running: 4, merges: [],
      epics: [
        { id: 3, name: "结账改版", rows: [epicRow], counts, features: [{ id: 7, name: "支付重构", rows: [coord, ticket], counts }] },
        { id: null, name: "", rows: [], counts, features: [{ id: null, name: "", rows: [loose], counts }] },
      ],
    };
    expect(rowPlace(view, ticket, S)).toEqual({ label: "BTL-1", name: "支付重构" });
    expect(rowPlace(view, coord, S)).toEqual({ label: "总控", name: "支付重构" });
    expect(rowPlace(view, epicRow, S)).toEqual({ label: "总控", name: "结账改版" });
    expect(rowPlace(view, loose, S)).toEqual({ label: "BTL-9", name: "独立的 ticket" });
  });
});
