import { describe, expect, it, vi } from "vitest";
import { MetricsRepo } from "../db/metrics-repo";
import { memDb } from "../test-utils";
import { GAP_MS, TOUCH_MS, WaitTracker, waitStateOf, type WaitHead } from "./wait-tracker";

const head = (o: Partial<WaitHead> = {}): WaitHead => ({
  id: "s1", ticketKey: "T-1", waiting: true, hibernated: false, kind: "waiting", permission: false, questionTool: false, needsYou: null, ...o,
});

function setup(heads: WaitHead[]) {
  const repo = new MetricsRepo(memDb());
  let now = 1000;
  const onHumanSpan = vi.fn();
  const t = new WaitTracker({ repo, heads: () => heads, now: () => now, onHumanSpan });
  return { repo, t, heads, onHumanSpan, at: (ms: number) => (now = ms) };
}

describe("waitStateOf", () => {
  it("orders human waits: permission, question tool, ask_user, needs-you", () => {
    expect(waitStateOf(head({ permission: true, kind: "approval", ask: "choice" }))).toEqual({ kind: "human", category: "permission", source: "permission_prompt" });
    expect(waitStateOf(head({ kind: "approval", questionTool: true, waiting: false, ask: "choice" }))).toEqual({ kind: "human", category: "choice", source: "question_tool" });
    expect(waitStateOf(head({ ask: "missing_info", needsYou: "question" }))).toEqual({ kind: "human", category: "missing_info", source: "ask_user" });
    expect(waitStateOf(head({ ask: null }))).toMatchObject({ category: "question", source: "ask_user" });
    expect(waitStateOf(head({ needsYou: "choice" }))).toEqual({ kind: "human", category: "choice", source: "needs_you" });
  });

  it("is idle when stopped with nothing for the user, and nothing while working or hibernated", () => {
    expect(waitStateOf(head())).toEqual({ kind: "idle", category: null, source: null });
    expect(waitStateOf(head({ waiting: false, kind: "edit" }))).toBeNull();
    expect(waitStateOf(head({ hibernated: true, needsYou: "question" }))).toBeNull();
  });

  it("does not turn a stale approval (a permission prompt just answered) into a choice", () => {
    expect(waitStateOf(head({ kind: "approval", waiting: false }))).toBeNull();
  });

  it("does not count a pending ask_user or needs-you while the session works on", () => {
    expect(waitStateOf(head({ ask: "question", waiting: false, kind: "edit" }))).toBeNull();
    expect(waitStateOf(head({ ask: "question", waiting: true, kind: "thinking" }))).toBeNull();
    expect(waitStateOf(head({ needsYou: "question", waiting: false, kind: "command" }))).toBeNull();
  });
});

describe("WaitTracker", () => {
  it("opens a span when a session starts waiting and closes it when the user answers", () => {
    const s = setup([head({ needsYou: "question" })]);
    s.t.sync();
    expect(s.onHumanSpan).toHaveBeenCalledTimes(1);
    expect(s.t.waitingFor("s1")).toBe("needs_you");
    s.at(5000);
    s.heads[0] = head({ waiting: false, kind: "thinking" });
    s.t.sync();
    expect(s.t.waitingFor("s1")).toBeNull();
    expect(s.repo.spans(0)).toEqual([expect.objectContaining({ kind: "human", category: "question", source: "needs_you", startedAt: 1000, endedAt: 5000 })]);
  });

  it("splits a wait into segments when what it waits for changes", () => {
    const s = setup([head()]);
    s.t.sync();
    s.at(2000);
    s.heads[0] = head({ needsYou: "missing_info" });
    s.t.sync();
    s.at(3000);
    s.t.sync();
    const spans = s.repo.spans(0);
    expect(spans.map((x) => [x.kind, x.startedAt, x.endedAt])).toEqual([["idle", 1000, 2000], ["human", 2000, null]]);
  });

  it("updates the category when an ask_user classification arrives, without a new span", () => {
    const s = setup([head({ ask: null })]);
    s.t.sync();
    s.heads[0] = head({ ask: "choice" });
    s.t.sync();
    expect(s.repo.spans(0)).toEqual([expect.objectContaining({ category: "choice", source: "ask_user" })]);
    expect(s.onHumanSpan).toHaveBeenCalledTimes(1);
  });

  it("does not count hibernated or closed sessions as waiting", () => {
    const s = setup([head({ needsYou: "question" })]);
    s.t.sync();
    s.at(4000);
    s.heads[0] = head({ hibernated: true, needsYou: "question" });
    s.t.sync();
    expect(s.repo.openSpans()).toHaveLength(0);
    s.heads[0] = head({ id: "s2" });
    s.t.sync();
    s.at(6000);
    s.heads.length = 0;
    s.t.sync();
    expect(s.repo.openSpans()).toHaveLength(0);
    expect(s.repo.spans(0).map((x) => x.endedAt)).toEqual([4000, 6000]);
  });

  it("touches open spans at most every TOUCH_MS, and recover() closes leftovers at their last sighting", () => {
    const s = setup([head()]);
    s.t.sync();
    s.at(1000 + TOUCH_MS - 1);
    s.t.sync();
    expect(s.repo.openSpans()[0].lastSeenAt).toBe(1000);
    s.at(1000 + TOUCH_MS);
    s.t.sync();
    expect(s.repo.openSpans()[0].lastSeenAt).toBe(1000 + TOUCH_MS);
    // 重启：新的 tracker 先补关。
    const t2 = new WaitTracker({ repo: s.repo, heads: () => [], now: () => 99_999_999 });
    expect(t2.recover()).toBe(1);
    expect(s.repo.spans(0)[0].endedAt).toBe(1000 + TOUCH_MS);
  });

  it("closeAll ends every open span", () => {
    const s = setup([head(), head({ id: "s2", permission: true })]);
    s.t.sync();
    s.at(2000);
    s.t.closeAll();
    expect(s.repo.openSpans()).toHaveLength(0);
  });

  it("does not count a sleep as waiting: the span ends at its last sighting and a new one starts on wake", () => {
    const s = setup([head({ needsYou: "question" })]);
    s.t.sync();
    s.at(1000 + TOUCH_MS);
    s.t.sync();
    const wake = 1000 + TOUCH_MS + GAP_MS + 1;
    s.at(wake);
    s.t.sync();
    expect(s.repo.spans(0).map((x) => [x.startedAt, x.endedAt])).toEqual([[1000, 1000 + TOUCH_MS], [wake, null]]);
    expect(s.onHumanSpan).toHaveBeenCalledTimes(2);
  });

  it("keeps one span across ordinary sync intervals", () => {
    const s = setup([head()]);
    s.t.sync();
    for (let i = 1; i <= 10; i++) {
      s.at(1000 + i * TOUCH_MS);
      s.t.sync();
    }
    expect(s.repo.spans(0)).toHaveLength(1);
  });

  it("never throws out of closeAll", () => {
    const repo = new MetricsRepo(memDb());
    const s = new WaitTracker({ repo, heads: () => [head()], now: () => 1, log: () => {} });
    s.sync();
    repo.closeSpan = () => {
      throw new Error("db closed");
    };
    expect(() => s.closeAll()).not.toThrow();
  });

  it("never throws out of sync", () => {
    const t = new WaitTracker({ repo: new MetricsRepo(memDb()), heads: () => { throw new Error("x"); }, now: () => 1, log: () => {} });
    expect(() => t.sync()).not.toThrow();
  });
});
