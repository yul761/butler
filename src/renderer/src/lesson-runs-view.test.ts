import { describe, expect, it, vi } from "vitest";
import type { LessonQueueRowStatus, LessonQueueRowView, LessonQueueView, LessonRunDetail, LessonRunSummary } from "../../shared/lessons";
import { S } from "./strings";
import type { LessonOrigin } from "../../shared/lessons";
import { EN } from "./strings-en";
import { formatDuration } from "./components/TicketActivity";
import { timeText, detailButtons, detailSections, openInClaudeOutcome, runDetailFacts, queueBarButtons, queueBarText, reasonText, retryAllCount, runErrorText, rowButtons, runCountsText, runSelectable, runStatusPill, RUNNING_TICK_MS, runningTicker, runStatusLabel, sourceLabel } from "./lesson-runs-view";

const now = new Date(2026, 10, 16, 12, 0).getTime();
const at = new Date(2026, 10, 16, 15, 0).getTime();
const queue = (over: Partial<LessonQueueView> = {}): LessonQueueView => ({ running: [], queued: 0, pause: null, ...over });
const run = (over: Partial<LessonRunSummary> = {}): LessonRunSummary => ({
  id: 1, status: "done", reason: null, startedAt: now - 5 * 60_000, finishedAt: now, created: 2, hit: 1, dropped: 0, costUsd: null, durationMs: null, ...over,
});
const row = (status: LessonQueueRowStatus, over: Partial<LessonQueueRowView> = {}): LessonQueueRowView => ({
  queueId: 7, prNumber: 12, prTitle: "t", origin: "daily", status, reason: null, message: null, attempts: 1, enqueuedAt: now - 10 * 60_000, finishedAt: null, notBefore: null, lastRun: null, ...over,
});

describe("queueBarText", () => {
  it("shows running, queued and the pause with its reset time", () => {
    const q = queue({
      running: [{ queueId: 1, runId: 2, slug: "acme/app", prNumber: 12, startedAt: now }],
      queued: 4,
      pause: { reason: "limit", until: at, message: "hit the limit" },
    });
    expect(queueBarText(q, S, now)).toEqual({ text: "正在分析 acme/app#12 · 队列 4 · 已暂停到 15:00 — hit the limit", tone: "warn" });
  });
  it("is quiet for a manual pause", () => {
    const r = queueBarText(queue({ queued: 2, pause: { reason: "manual", until: null, message: null } }), S, now);
    expect(r).toEqual({ text: "队列 2 · 已手动暂停", tone: "muted" });
  });
  it("says idle when there is nothing", () => {
    expect(queueBarText(queue(), EN, now)).toEqual({ text: "Queue idle", tone: "muted" });
  });
  it("is ok while running and not paused", () => {
    const q = queue({ running: [{ queueId: 1, runId: 2, slug: "a/b", prNumber: 3, startedAt: now }] });
    expect(queueBarText(q, EN, now)).toEqual({ text: "Analysing a/b#3", tone: "ok" });
  });
});

describe("queueBarButtons", () => {
  it("offers resume while paused and pause otherwise; run now when paused or queued", () => {
    expect(queueBarButtons(queue())).toEqual({ toggle: "pause", runNow: false });
    expect(queueBarButtons(queue({ queued: 1 }))).toEqual({ toggle: "pause", runNow: true });
    expect(queueBarButtons(queue({ pause: { reason: "manual", until: null, message: null } }))).toEqual({ toggle: "resume", runNow: true });
  });
});

describe("runStatusPill", () => {
  it("maps statuses to tones", () => {
    const tone = (s: LessonQueueRowStatus) => runStatusPill(row(s), S, now).tone;
    expect(tone("failed")).toBe("danger");
    expect(tone("limited")).toBe("warn");
    expect(tone("done")).toBe("ok");
    expect(["queued", "waiting", "skipped", "cancelled"].map((s) => tone(s as LessonQueueRowStatus))).toEqual(["muted", "muted", "muted", "muted"]);
    expect(runStatusPill(row("failed"), S, now).text).toBe("失败");
  });
  it("running pill shows elapsed time", () => {
    // 和 LessonsService.runs 给的一样：正在跑的这次，还没结束、没有计数。
    const r = row("running", { lastRun: run({ status: "running", startedAt: now - 5 * 60_000, finishedAt: null, created: 0, hit: 0 }) });
    expect(runStatusPill(r, S, now)).toEqual({ text: "分析中 · 5 分钟", tone: "muted" });
  });
});

describe("runningTicker", () => {
  it("ticks every 30 s while a row is running and stops on cleanup", () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn();
      const stop = runningTicker([row("queued"), row("running")], tick);
      vi.advanceTimersByTime(RUNNING_TICK_MS - 1);
      expect(tick).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(tick).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(RUNNING_TICK_MS);
      expect(tick).toHaveBeenCalledTimes(2);
      stop();
      vi.advanceTimersByTime(10 * RUNNING_TICK_MS);
      expect(tick).toHaveBeenCalledTimes(2);
      expect(RUNNING_TICK_MS).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });
  it("sets no timer when nothing is running", () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn();
      const stop = runningTicker([row("queued"), row("done")], tick);
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(10 * RUNNING_TICK_MS);
      expect(tick).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reasonText", () => {
  it("translates known codes, including claude_missing, in both languages", () => {
    expect(reasonText("claude_missing", S)).toBe("找不到 claude");
    expect(reasonText("claude_missing", EN)).toBe("claude was not found");
    expect(reasonText(null, S)).toBeNull();
  });
  it("shows unknown reason codes raw", () => {
    expect(reasonText("weird_code", S)).toBe("weird_code");
    expect(reasonText("constructor", S)).toBe("constructor");
  });
});

describe("runCountsText / sourceLabel", () => {
  it("formats counts", () => {
    expect(runCountsText(run({ created: 3, hit: 2, dropped: 1 }), S)).toBe("新 3 · 再次 2 · 丢弃 1");
  });
  it("product sources show slug#N, repo sources #N", () => {
    const src = { id: 1, prNumber: 9, url: null, at: 0, slug: "o/api", runId: null };
    expect(sourceLabel(src, { kind: "product", productId: 1 })).toBe("o/api#9");
    expect(sourceLabel({ ...src, slug: null }, { kind: "product", productId: 1 })).toBe("#9");
    expect(sourceLabel(src, { kind: "repo", slug: "o/api" })).toBe("#9");
  });
});

describe("row buttons", () => {
  it("retry for failed, skipped, cancelled; cancel for queued, waiting, limited, running", () => {
    const b = (s: LessonQueueRowStatus) => rowButtons(s);
    expect(b("failed")).toEqual(["retry"]);
    expect(b("skipped")).toEqual(["retry"]);
    expect(b("cancelled")).toEqual(["retry"]);
    // 受限的行等限额重置后自己会跑：重试也只是再撞一次限额。
    expect(b("limited")).toEqual(["cancel"]);
    expect(b("queued")).toEqual(["cancel"]);
    expect(b("waiting")).toEqual(["cancel"]);
    expect(b("running")).toEqual(["cancel"]);
    expect(b("done")).toEqual([]);
  });
  it("retry all failed appears only when something failed", () => {
    expect(retryAllCount([row("done"), row("queued")])).toBe(0);
    expect(retryAllCount([row("failed"), row("failed", { queueId: 8 }), row("skipped")])).toBe(2);
  });
  it("a row never started is not selectable", () => {
    expect(runSelectable(row("queued"))).toBe(false);
    expect(runSelectable(row("failed", { lastRun: run() }))).toBe(true);
  });
});

describe("separators, origins and run errors", () => {
  it("joins several running items with the language's separator", () => {
    const q = queue({ running: [{ queueId: 1, runId: 1, slug: "a/b", prNumber: 1, startedAt: now }, { queueId: 2, runId: 2, slug: "a/b", prNumber: 2, startedAt: now }] });
    expect(queueBarText(q, EN, now).text).toBe("Analysing a/b#1, a/b#2");
    expect(queueBarText(q, S, now).text).toBe("正在分析 a/b#1、a/b#2");
  });
  it("labels every origin in both languages", () => {
    const all: LessonOrigin[] = ["backfill", "merged", "daily"];
    expect(all.map((o) => S.lessonRunOrigin[o])).toEqual(["补录", "已合并", "每日"]);
    expect(all.map((o) => EN.lessonRunOrigin[o])).toEqual(["Backfill", "Merged", "Daily"]);
  });
  it("uses run wording for not_found and bad_status, falling back to the lesson wording", () => {
    expect(runErrorText("not_found", EN)).toBe("This analysis no longer exists.");
    expect(runErrorText("bad_status", S)).toBe("这条分析的状态已经变了，请刷新后再试。");
    expect(runErrorText("no_gh", EN)).toBe(EN.lessonsError.no_gh);
    expect(runErrorText("zzz", EN)).toBe(EN.lessonsErrorGeneric);
  });
});

const detail = (over: Partial<LessonRunDetail> = {}): LessonRunDetail => ({
  ...run({ id: 5 }), slug: "acme/app", prNumber: 12, prUrl: "https://github.com/acme/app/pull/12", prTitle: "t", origin: "daily",
  message: null, stderrTail: null, ghStderr: null, material: "M", rawOutput: "R", trimmed: false, findings: [], model: null, inputTokens: null, outputTokens: null,
  lessons: [], attempts: [], ...over,
});

describe("runDetailFacts", () => {
  it("formats cost, tokens and duration and omits nulls", () => {
    const d = detail({ status: "failed", reason: "usage_limit", durationMs: 125_000, costUsd: 0.01234, model: "opus", inputTokens: 1000, outputTokens: 50, attempts: [run({ id: 3 }), run({ id: 9 })] });
    const facts = Object.fromEntries(runDetailFacts(d, S));
    expect(facts[S.lessonRunFact.status]).toBe("失败 · 用量已达上限");
    expect(facts[S.lessonRunFact.cost]).toBe("$0.0123");
    expect(facts[S.lessonRunFact.tokens]).toBe("1000 / 50");
    expect(facts[S.lessonRunFact.model]).toBe("opus");
    expect(facts[S.lessonRunFact.attempt]).toBe("2 / 3");
    expect(facts[S.lessonRunFact.duration]).toBe(formatDuration(125_000, S));
    expect(facts[S.lessonRunFact.started]).toBe(timeText(d.startedAt));
    const bare = runDetailFacts(detail(), S).map(([k]) => k);
    expect(bare).toEqual([S.lessonRunFact.status, S.lessonRunFact.started, S.lessonRunFact.attempt]);
  });
});

describe("runStatusLabel", () => {
  it("labels an aborted run Interrupted, not failed, in the facts and the attempts list", () => {
    expect(runStatusLabel("aborted", S)).toBe("中断");
    expect(runStatusLabel("aborted", EN)).toBe("Interrupted");
    expect(runStatusLabel("failed", S)).toBe("失败");
    expect(runStatusLabel("running", EN)).toBe("Running");
    const facts = Object.fromEntries(runDetailFacts(detail({ status: "aborted", reason: "app_quit" }), EN));
    expect(facts[EN.lessonRunFact.status]).toBe(`Interrupted · ${EN.lessonRunReason.app_quit}`);
  });
});

describe("detailSections", () => {
  it("shows message, stderr, gh stderr and material for a failed run", () => {
    const s = detailSections(detail({ status: "failed", message: "boom", stderrTail: "err", ghStderr: "gh err" }));
    expect(s).toMatchObject({ message: "boom", stderr: "err", ghStderr: "gh err", material: "M", rawOutput: "R", trimmedNote: false });
  });
  it("shows the trimmed note instead of material for a trimmed run", () => {
    const s = detailSections(detail({ trimmed: true, material: null, rawOutput: null, findings: null }));
    expect(s).toMatchObject({ material: null, rawOutput: null, trimmedNote: true, findings: null });
  });
  it("shows lessons, dropped and findings for a done run", () => {
    const f = { summary: "s", avoidable: true, whyMissed: "w", rule: null, commentUrl: null };
    const s = detailSections(detail({ dropped: 2, findings: [f], lessons: [{ id: 1, text: "x", status: "pending", kind: "created" }], attempts: [run()] }));
    expect(s).toMatchObject({ lessons: true, dropped: true, findings: [f], attempts: true });
    expect(detailSections(detail({ findings: [] })).findings).toBeNull();
    expect(detailSections(detail()).lessons).toBe(false);
  });
});

describe("detailButtons", () => {
  it("offers retry and open for a failed latest run, cancel while running", () => {
    expect(detailButtons(detail(), "failed")).toEqual(["retry", "open"]);
    expect(detailButtons(detail(), "running")).toEqual(["cancel", "open"]);
    expect(detailButtons(detail(), "done")).toEqual(["open"]);
  });
  it("has no queue actions for an earlier run, and still open when trimmed", () => {
    expect(detailButtons(detail(), null)).toEqual(["open"]);
    expect(detailButtons(detail({ trimmed: true, material: null }), "failed")).toEqual(["retry", "open"]);
  });
});

describe("openInClaudeOutcome", () => {
  it("navigates to the returned session", () => {
    expect(openInClaudeOutcome({ ok: true, sessionId: "t1" }, S)).toEqual({ kind: "open", sessionId: "t1" });
  });
  it("shows a localized error otherwise", () => {
    expect(openInClaudeOutcome({ ok: false, reason: "claude_missing" }, S)).toEqual({ kind: "error", text: S.lessonsError.claude_missing });
    expect(openInClaudeOutcome({ ok: false, reason: "write_failed" }, EN)).toEqual({ kind: "error", text: EN.lessonsError.write_failed });
    expect(openInClaudeOutcome({ ok: false, reason: "zzz" }, S)).toEqual({ kind: "error", text: S.lessonsErrorGeneric });
    expect(openInClaudeOutcome({ ok: true }, S)).toEqual({ kind: "none" });
  });
});
