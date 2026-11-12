import { afterEach, describe, expect, it } from "vitest";
import type { ActivityEvent, SessionActivity } from "../../shared/activity";
import type { InboxItemView, NowRow, NowView, UsageSummary, WatchedPr } from "../../shared/types";
import {
  groupSummary, inboxWho, liveMemoryLine, liveNeeds, livePill, liveRows, mergeEvents, needsYouText, needsYouTotal, prPill, rowLabel, wirePath, rowPlace, rowText, usageDetails, usageLine,
} from "./now-view";
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
  sessionId: "s1", ticketKey: "BTL-1", title: "通知中心", repo: null, where: "app", coordinator: false, activity: act(), working: true, recent: [], mergeQueued: false,
  needsYou: null, refreshing: null, decisions: 0, prs: [], idle: false, since: NOW - 3 * MIN, target: { page: "ticket", key: "BTL-1", sessionId: "s1" }, ...over,
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

  it("a row with a pending ask_user reads 等你决定 (BTL-190 2+3)", () => {
    expect(rowText(row({ decisions: 2, activity: act({ kind: "waiting" }) }), S, NOW)).toMatchObject({ main: "等你决定", tone: "danger" });
    // 停在确认上的照样先说确认。
    expect(rowText(row({ decisions: 1, needsYou: "等你确认", activity: act({ kind: "approval" }) }), S, NOW).main).toBe("等你：等你确认");
    setUiLang("en");
    expect(rowText(row({ decisions: 1, activity: act({ kind: "waiting" }) }), S, NOW).main).toBe("Waiting for your decision");
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
    expect(groupSummary({ active: 3, needsYou: 1, stuck: 0 }, S)).toBe("3 个在干活 · 1 需要你");
    expect(groupSummary({ active: 2, needsYou: 0, stuck: 1 }, S)).toBe("2 个在干活 · 1 卡住");
    expect(groupSummary({ active: 0, needsYou: 0, stuck: 0 }, S)).toBe("没人在干活");
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
      needsYou: [], decisions: [], butler: null, running: 4, merges: [], memory: [],
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

describe("inbox helpers (BTL-190 2+3)", () => {
  const item = (over: Partial<InboxItemView> = {}): InboxItemView => ({
    id: 1, kind: "decision", sessionId: "s1", role: "ticket", ticketKey: "BTL-1", featureId: 2, epicId: null, repo: null, text: "用哪个？",
    options: [], context: null, reportKind: null, answer: null, createdAt: NOW, open: true, target: { page: "ticket", key: "BTL-1", sessionId: "s1" }, ...over,
  });

  it("names who asked or reported", () => {
    expect(inboxWho(item(), S)).toBe("BTL-1");
    expect(inboxWho(item({ repo: "api" }), S)).toBe("BTL-1（api）");
    expect(inboxWho(item({ role: "ticket_coordinator" }), S)).toBe("BTL-1 总控");
    expect(inboxWho(item({ role: "feature_coordinator", ticketKey: null }), S)).toBe("feature 总控");
    expect(inboxWho(item({ role: "butler", ticketKey: null }), S)).toBe("Butler 总控");
    setUiLang("en");
    expect(inboxWho(item({ role: "epic", ticketKey: null }), S)).toBe("Epic session");
  });

  it("counts every pending decision as one more thing that needs you", () => {
    expect(needsYouTotal(null)).toBe(0);
    expect(needsYouTotal({ needsYou: [row()], decisions: [item(), item({ id: 2 })], epics: [], butler: null, running: 1, merges: [], memory: [] })).toBe(3);
    // 已经在卡片上答了、等着送进去的不算。
    expect(needsYouTotal({ needsYou: [], decisions: [item(), item({ id: 2, answer: "A" })], epics: [], butler: null, running: 1, merges: [], memory: [] })).toBe(1);
  });
});

describe("the live window (BTL-190 7)", () => {
  const ev = (at: number, label: string, over: Partial<ActivityEvent> = {}): ActivityEvent => ({ sessionId: "s1", at, kind: "tool", label, ...over });
  const counts = { active: 0, needsYou: 0, stuck: 0 };
  const view = (rows: NowRow[], featureRows: NowRow[] = [], butler: NowRow | null = null): NowView => ({
    needsYou: [], decisions: [], butler, running: 0, merges: [], memory: [],
    epics: [{ id: 1, name: "e", rows, counts, features: [{ id: 2, name: "f", rows: featureRows, counts }] }],
  });

  it("shows sessions that are working or waiting for you, and leaves out stopped ones and PR-only rows", () => {
    const working = row({ sessionId: "w" });
    const stopped = row({ sessionId: "s", working: false, activity: act({ kind: "waiting" }) });
    const approval = row({ sessionId: "a", working: false, activity: act({ kind: "approval" }), needsYou: "等你确认" });
    const decided = row({ sessionId: "d", working: false, activity: act({ kind: "waiting" }), decisions: 2 });
    const prOnly = row({ sessionId: null, working: false, activity: null });
    expect(liveRows(view([working], [stopped, approval, decided, prOnly])).map((r) => r.sessionId)).toEqual(["w", "a", "d"]);
    // Butler 总控在最前，卡片上写「Butler 总控」。
    const butler = row({ sessionId: "b", ticketKey: null, title: null, coordinator: true, working: false, activity: act({ kind: "waiting" }), needsYou: "在问你", target: { page: "butler", sessionId: "b" } });
    expect(liveRows(view([working], [], butler)).map((r) => r.sessionId)).toEqual(["b", "w"]);
    expect(rowLabel(butler, S)).toBe("Butler 总控");
    expect(liveRows(view([], [stopped]))).toEqual([]);
  });

  it("counts what a card needs from you: the needs-you reason and every pending decision", () => {
    expect(liveNeeds(row())).toBe(0);
    expect(liveNeeds(row({ needsYou: "等你确认", decisions: 2 }))).toBe(3);
    expect(liveNeeds(row({ needsYou: "" }))).toBe(1);
  });

  it("gives the pill a short state: blinking while working, yellow while waiting for you, red when stuck", () => {
    expect(livePill(row(), S)).toEqual({ text: "写代码", tone: "work" });
    expect(livePill(row({ activity: act({ kind: "command", background: true }) }), S)).toEqual({ text: "后台 · 运行命令", tone: "work" });
    expect(livePill(row({ working: false, activity: act({ kind: "approval" }), needsYou: "等你确认" }), S)).toEqual({ text: "等你批准", tone: "need" });
    expect(livePill(row({ working: false, activity: act({ kind: "waiting" }), decisions: 1 }), S)).toEqual({ text: "等你决定", tone: "need" });
    expect(livePill(row({ working: false, activity: act({ kind: "waiting" }), needsYou: "要拆 PR 吗？" }), S)).toEqual({ text: "等你", tone: "need" });
    expect(livePill(row({ activity: act({ kind: "test", stuck: true }), needsYou: "测试没有输出" }), S)).toEqual({ text: "卡住", tone: "stuck" });
    setUiLang("en");
    expect(livePill(row({ working: false, activity: act({ kind: "waiting" }), needsYou: "?" }), S).text).toBe("Waiting for you");
  });

  it("merges the lines from the last fetch with the pushed events: no duplicates, oldest first, the last few", () => {
    const fetched = [ev(1, "Read a.ts"), ev(2, "Edit b.ts")];
    const pushed = [ev(2, "Edit b.ts"), ev(3, "Bash pnpm test"), ev(4, "x", { kind: "turn-end", label: "" }), ev(5, "其它 session", { sessionId: "s2" })];
    expect(mergeEvents(fetched, pushed, 3, (e) => e.sessionId === "s1").map((e) => e.label)).toEqual(["Read a.ts", "Edit b.ts", "Bash pnpm test"]);
    expect(mergeEvents(fetched, pushed, 2, (e) => e.sessionId === "s1").map((e) => e.label)).toEqual(["Edit b.ts", "Bash pnpm test"]);
    // 同一个时间、同一个工具的两次调用是两条。
    expect(mergeEvents([ev(1, "Read a.ts")], [ev(1, "Read b.ts")], 3, () => true)).toHaveLength(2);
  });

  it("names the card and the memory line by who did it", () => {
    expect(rowLabel(row(), S)).toBe("BTL-1");
    expect(rowLabel(row({ ticketKey: null, coordinator: true }), S)).toBe("总控");
    expect(rowLabel(row({ ticketKey: null, coordinator: false }), S)).toBe("修复");
    const rows = [row()];
    expect(liveMemoryLine(ev(1, "接口改成 v2", { kind: "memory-write" }), rows, S)).toEqual({ who: "BTL-1", verb: "写入", label: "接口改成 v2" });
    expect(liveMemoryLine(ev(1, "checkout", { kind: "memory-read", sessionId: "gone" }), rows, S)).toEqual({ who: "", verb: "读取", label: "checkout" });
  });

  it("draws the wire from the side of the card that faces the core to the core's edge", () => {
    const core = { x: 300, y: 100, w: 200, h: 200 };
    // 左边的卡片：从右边的中间出发，落在核心左边，高度贴着卡片。
    expect(wirePath({ x: 0, y: 150, w: 240, h: 60 }, core)).toBe("M240 180 C270 180 270 180 300 180");
    // 右边、比核心还高的卡片：落点压到离核心上角 14px。
    expect(wirePath({ x: 560, y: 0, w: 240, h: 40 }, core)).toBe("M560 20 C530 20 530 114 500 114");
    // 窄窗口里叠在核心下面：竖着连到核心的底边。
    expect(wirePath({ x: 320, y: 340, w: 100, h: 60 }, core)).toBe("M370 340 C370 320 370 320 370 300");
  });
});

