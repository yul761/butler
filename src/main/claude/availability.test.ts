import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { AvailabilityRepo } from "../db/availability-repo";
import { BACKOFF_MINUTES, ClaudeAvailability, HIT_DEDUPE_MS, MODEL_RETRY_MS, RESUME_SLACK_MS } from "./availability";

const MIN = 60_000;
const T0 = 1_000_000_000;

function setup(db = memDb(), t0 = T0) {
  const clock = { t: t0 };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const repo = new AvailabilityRepo(db);
  let saves = 0;
  const save = repo.save.bind(repo);
  repo.save = (s, n) => { saves += 1; save(s, n); };
  let changes = 0;
  const make = () =>
    new ClaudeAvailability({
      repo, now: () => clock.t, onChange: () => { changes += 1; },
      setTimer: (fn, ms) => { const t = { fn: () => { t.live = false; fn(); }, ms, live: true }; timers.push(t); return t; },
      clearTimer: (t) => { (t as { live: boolean }).live = false; },
    });
  const a = make();
  const live = () => timers.filter((t) => t.live);
  return { a, make, db, clock, timers, live, saves: () => saves, changes: () => changes };
}
const usage = (over: Record<string, unknown> = {}) =>
  ({ kind: "usage_limit" as const, resetsAt: null, message: "limit", source: "headless" as const, job: "lessons", sessionId: null, ...over });

describe("ClaudeAvailability", () => {
  it("a usage limit with a reset pauses lessons until reset plus 60s", () => {
    const s = setup();
    s.a.report(usage({ resetsAt: T0 + 30 * MIN }));
    const v = s.a.view();
    expect(v.state).toBe("limited");
    expect(v.retryAt).toBe(T0 + 30 * MIN + RESUME_SLACK_MS);
    expect(v.lessonsPause).toEqual({ reason: "limit", since: T0, until: T0 + 30 * MIN + RESUME_SLACK_MS });
    expect(s.a.lessonsGate(T0)).toMatchObject({ paused: true, reason: "limit", until: v.retryAt, message: "limit" });
    expect(s.a.lessonsGate(v.retryAt! + 1)).toEqual({ paused: false });
    expect(s.live()[0]!.ms).toBe(30 * MIN + RESUME_SLACK_MS);
  });

  it("without a reset the backoff runs 10, 20, 40, 80, 120, 120 minutes", () => {
    const s = setup();
    const got: number[] = [];
    for (let i = 0; i < 6; i++) {
      s.a.report(usage());
      got.push((s.a.view().retryAt! - s.clock.t) / MIN);
      s.clock.t += 2 * HIT_DEDUPE_MS;
    }
    expect(got).toEqual([10, 20, 40, 80, 120, 120]);
    expect(BACKOFF_MINUTES).toEqual([10, 20, 40, 80, 120]);
  });

  it("two hits within 60s advance the backoff once", () => {
    const s = setup();
    s.a.report(usage());
    s.clock.t += 10_000;
    s.a.report(usage());
    expect((s.a.view().retryAt! - T0) / MIN).toBe(10);
    s.clock.t += 2 * HIT_DEDUPE_MS;
    s.a.report(usage());
    expect((s.a.view().retryAt! - s.clock.t) / MIN).toBe(20);
  });

  it("a session usage limit pauses lessons; a past reset falls back to backoff", () => {
    const s = setup();
    s.a.report(usage({ source: "session", job: null, sessionId: "s1", resetsAt: T0 - 5 * MIN }));
    expect(s.a.view().retryAt).toBe(T0 + 10 * MIN);
    expect(s.a.view().lessonsPause?.reason).toBe("limit");
    expect(s.a.view().current?.sessionId).toBe("s1");
  });

  it("model_unavailable from lessons pauses for 60 minutes; from a judge it only records lastHit", () => {
    const s = setup();
    s.a.report(usage({ kind: "model_unavailable", job: "stuck judge" }));
    expect(s.a.view()).toMatchObject({ state: "ok", current: null, retryAt: null, lessonsPause: null });
    expect(s.a.view().lastHit?.job).toBe("stuck judge");
    s.a.report(usage({ kind: "model_unavailable", job: "lessons" }));
    const v = s.a.view();
    expect(v.state).toBe("model_unavailable");
    expect(v.retryAt).toBe(T0 + MODEL_RETRY_MS);
    expect(v.lessonsPause).toEqual({ reason: "model", since: T0, until: T0 + MODEL_RETRY_MS });
  });

  it("the timer clears the pause and emits", () => {
    const s = setup();
    s.a.report(usage());
    const before = s.changes();
    s.clock.t += 10 * MIN;
    s.live()[0]!.fn();
    expect(s.a.view()).toMatchObject({ state: "ok", current: null, retryAt: null, lessonsPause: null });
    expect(s.a.view().lastHit).not.toBeNull();
    expect(s.changes()).toBe(before + 1);
    expect(s.live()).toHaveLength(0);
  });

  it("noteSuccess clears a limit pause and resets the backoff", () => {
    const s = setup();
    s.a.report(usage());
    s.clock.t += 2 * HIT_DEDUPE_MS;
    s.a.report(usage());
    s.a.noteSuccess(s.clock.t, "handoff");
    expect(s.a.view()).toMatchObject({ state: "ok", current: null, retryAt: null, lessonsPause: null });
    expect(s.live()).toHaveLength(0);
    s.clock.t += 2 * HIT_DEDUPE_MS;
    s.a.report(usage());
    expect((s.a.view().retryAt! - s.clock.t) / MIN).toBe(10);
  });

  it("noteSuccess clears a model pause only for lessons", () => {
    const s = setup();
    s.a.report(usage({ kind: "model_unavailable", job: "lessons" }));
    s.a.noteSuccess(T0, "handoff");
    expect(s.a.view().lessonsPause?.reason).toBe("model");
    s.a.noteSuccess(T0, "lessons");
    expect(s.a.view()).toMatchObject({ state: "ok", lessonsPause: null, retryAt: null });
  });

  it("noteSuccess never clears a manual pause", () => {
    const s = setup();
    s.a.pauseLessons();
    expect(s.a.lessonsGate(T0)).toEqual({ paused: true, reason: "manual", until: null, message: null });
    s.a.report(usage());
    expect(s.a.view().lessonsPause?.reason).toBe("manual");
    s.a.noteSuccess(T0, "lessons");
    expect(s.a.view().lessonsPause).toEqual({ reason: "manual", since: T0, until: null });
    expect(s.a.view().current).toBeNull();
  });

  it("noteSuccess with nothing to clear does not save or emit", () => {
    const s = setup();
    const [saves, changes] = [s.saves(), s.changes()];
    s.a.noteSuccess(T0, "lessons");
    expect([s.saves(), s.changes()]).toEqual([saves, changes]);
  });

  it("resumeLessons clears everything", () => {
    const s = setup();
    s.a.report(usage());
    s.a.pauseLessons();
    s.a.resumeLessons();
    expect(s.a.view()).toMatchObject({ state: "ok", current: null, retryAt: null, lessonsPause: null });
    expect(s.live()).toHaveLength(0);
    s.clock.t += 2 * HIT_DEDUPE_MS;
    s.a.report(usage());
    expect((s.a.view().retryAt! - s.clock.t) / MIN).toBe(10);
  });

  it("an expired persisted pause is cleared at construction", () => {
    const s = setup();
    s.a.report(usage());
    s.clock.t += 11 * MIN;
    const b = s.make();
    expect(b.view()).toMatchObject({ state: "ok", current: null, retryAt: null, lessonsPause: null });
    expect(new AvailabilityRepo(s.db).load()?.retryAt).toBeNull();
  });

  it("an unexpired persisted pause resumes on its timer", () => {
    const s = setup();
    s.a.report(usage());
    s.clock.t += 4 * MIN;
    const b = s.make();
    expect(b.view().state).toBe("limited");
    const t = s.live().at(-1)!;
    expect(t.ms).toBe(6 * MIN);
    s.clock.t += 6 * MIN;
    t.fn();
    expect(b.view().state).toBe("ok");
  });

  it("a throwing subscriber does not stop the others", () => {
    const s = setup();
    let seen = 0;
    s.a.subscribe(() => { throw new Error("boom"); });
    s.a.subscribe(() => { seen += 1; });
    s.a.report(usage());
    expect(seen).toBe(1);
  });

  it("dispose clears the timer", () => {
    const s = setup();
    s.a.report(usage());
    s.a.dispose();
    expect(s.live()).toHaveLength(0);
  });

  it("a partial stored row loads with nulls", () => {
    const s = setup();
    s.db.prepare(`INSERT INTO claude_availability (id, state, updated_at) VALUES (1, '{"backoffStep":99}', 1)`).run();
    const b = s.make();
    expect(b.view()).toEqual({ state: "ok", current: null, lastHit: null, retryAt: null, lessonsPause: null });
    expect(b.lessonsGate(T0)).toEqual({ paused: false });
  });

  it("a far-future reset clamps the timer and an early fire keeps the pause", () => {
    const s = setup();
    s.a.report(usage({ resetsAt: T0 + 40 * 86_400_000 }));
    const t = s.live()[0]!;
    expect(t.ms).toBe(2 ** 31 - 1);
    s.clock.t += t.ms;
    t.fn();
    expect(s.a.view().state).toBe("limited");
    expect(s.a.view().lessonsPause?.reason).toBe("limit");
    expect(s.live()).toHaveLength(1);
  });
});
