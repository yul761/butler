import { describe, expect, it } from "vitest";
import type { LessonQueueRowStatus, LessonQueueRowView, LessonQueueView, LessonRunSummary } from "../../shared/lessons";
import { S } from "./strings";
import { EN } from "./strings-en";
import { queueBarButtons, queueBarText, reasonText, retryAllCount, rowButtons, runCountsText, runSelectable, runStatusPill, sourceLabel } from "./lesson-runs-view";

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
    const r = row("running", { lastRun: run({ status: "running", startedAt: now - 5 * 60_000 }) });
    expect(runStatusPill(r, S, now)).toEqual({ text: "分析中 · 5 分钟", tone: "muted" });
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
  it("retry for failed, skipped, cancelled, limited; cancel for queued, waiting, limited, running", () => {
    const b = (s: LessonQueueRowStatus) => rowButtons(s);
    expect(b("failed")).toEqual(["retry"]);
    expect(b("skipped")).toEqual(["retry"]);
    expect(b("cancelled")).toEqual(["retry"]);
    expect(b("limited")).toEqual(["retry", "cancel"]);
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
