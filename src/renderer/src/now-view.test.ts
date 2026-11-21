import { afterEach, describe, expect, it } from "vitest";
import type { ActivityEvent, SessionActivity } from "../../shared/activity";
import type { InboxItemView, NowRow, NowView, UsageSummary, WatchedPr } from "../../shared/types";
import {
  inboxWho, liveMemoryLine, liveNeeds, livePill, liveRows, mergeEvents, prPill, rowLabel, wirePath, usageDetails, usageLine,
} from "./now-view";
import { S, setUiLang } from "./strings";

const NOW = 1_000_000_000_000;
const MIN = 60_000;

const act = (over: Partial<SessionActivity> = {}): SessionActivity => ({
  sessionId: "s1", kind: "edit", detail: "notify.ts", background: false, startedAt: NOW - 3 * MIN, lastOutputAt: null,
  stuck: null, reason: null, action: null, lastOutput: [], ...over,
});

const pr = (over: Partial<WatchedPr> = {}): WatchedPr => ({
  ticketKey: "BTL-1", prId: 1, repoId: 1, repoPath: "/r", branch: "b", number: 212, url: "https://github.com/o/r/pull/212",
  state: "open", review: "pending", ci: "passing", headSha: null, checkedAt: NOW, readError: false, ...over,
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

  it("says the PR status is unavailable when the last gh read failed (I6)", () => {
    expect(prPill(pr({ state: null, number: null, url: null, prId: null, ci: "unknown", readError: true }), S)).toEqual({ text: "PR 状态不可用", tone: "none" });
    expect(prPill(pr({ readError: true }), S)).toEqual({ text: "PR 状态不可用", tone: "none" });
    setUiLang("en");
    expect(prPill(pr({ readError: true }), S)).toEqual({ text: "PR status unavailable", tone: "none" });
    setUiLang("zh");
    // 读成功了、只是还不知道 CI：照常显示。
    expect(prPill(pr({ ci: "unknown" }), S)).toEqual({ text: "PR #212 待 review", tone: "pending" });
    expect(prPill(pr({ state: null, number: null, url: null, prId: null, ci: "unknown" }), S)).toBeNull();
  });

  it("shows nothing for a branch with no PR or a closed one", () => {
    expect(prPill(pr({ state: null, number: null, url: null }), S)).toBeNull();
    expect(prPill(pr({ state: "closed" }), S)).toBeNull();
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

describe("inbox helpers (BTL-190 2+3)", () => {
  const item = (over: Partial<InboxItemView> = {}): InboxItemView => ({
    id: 1, kind: "decision", sessionId: "s1", role: "ticket", ticketKey: "BTL-1", featureId: 2, repo: null, text: "用哪个？",
    options: [], context: null, reportKind: null, answer: null, createdAt: NOW, open: true, target: { page: "ticket", key: "BTL-1", sessionId: "s1" }, ...over,
  });

  it("names who asked or reported", () => {
    expect(inboxWho(item(), S)).toBe("BTL-1");
    expect(inboxWho(item({ repo: "api" }), S)).toBe("BTL-1（api）");
    expect(inboxWho(item({ role: "feature_coordinator", ticketKey: null }), S)).toBe("epic 总控");
    expect(inboxWho(item({ role: "butler", ticketKey: null }), S)).toBe("全局总控");
    setUiLang("en");
    expect(inboxWho(item({ role: "feature_coordinator", ticketKey: null }), S)).toBe("Epic coordinator");
    expect(inboxWho(item({ role: "butler", ticketKey: null }), S)).toBe("Global control");
  });

});

describe("the live window (BTL-190 7)", () => {
  const ev = (at: number, label: string, over: Partial<ActivityEvent> = {}): ActivityEvent => ({ sessionId: "s1", at, kind: "tool", label, ...over });
  const counts = { active: 0, needsYou: 0, stuck: 0 };
  const view = (rows: NowRow[], featureRows: NowRow[] = [], butler: NowRow | null = null): NowView => ({
    butler, running: 0, merges: [], memory: [], notices: [],
    features: [{ id: 1, name: "e", rows, counts }, { id: 2, name: "f", rows: featureRows, counts }],
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
    expect(rowLabel(butler, S)).toBe(S.butlerNav);
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

