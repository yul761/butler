import { describe, expect, it } from "vitest";
import { EMPTY_BRIEF_CONTENT, type Brief, type BriefKind } from "../../shared/brief";
import { JOB_EVENING, JOB_MORNING, JOB_NIGHTLY, JobsRepo } from "../db/jobs-repo";
import { memDb } from "../test-utils";
import { BackgroundRunner, morningJob, nightlyJob, type DailyJobDeps } from "./daily-jobs";
import { Scheduler } from "./scheduler";

const brief = (kind: BriefKind, withContent = true): Brief => ({
  id: 1, kind, date: "2026-10-21", createdAt: 1, ...EMPTY_BRIEF_CONTENT,
  evening: kind === "evening" && withContent ? [{ ticketKey: "A-1", done: ["x"], blockers: [], next: null, degraded: false }] : [],
  narrative: null, narrativeStatus: "off",
});

function deps(over: Partial<DailyJobDeps> = {}) {
  const calls: string[] = [];
  const jobs = new JobsRepo(memDb());
  const d: DailyJobDeps = {
    runner: {
      runNightly: async () => {
        calls.push("runNightly");
        return { status: "partial", outcomes: [] };
      },
      refreshForBrief: async () => {
        calls.push("refresh");
        return { status: "ok", outcomes: [{ ticketKey: "A-1", status: "stored", handoffId: 1, degraded: false }] };
      },
    },
    briefs: {
      generateMorning: () => {
        calls.push("morning");
        return brief("morning");
      },
      generateEvening: () => {
        calls.push("evening");
        return brief("evening");
      },
    },
    jobs,
    now: () => 123,
    isWorkingDay: () => true,
    setRefreshing: (v) => calls.push(`refreshing=${v}`),
    onEvening: (b) => calls.push(`notify:${b.kind}`),
    ...over,
  };
  return { d, calls, jobs };
}

describe("daily jobs", () => {
  it("nightly: batch, then the evening summary and a notification", async () => {
    const { d, calls, jobs } = deps();
    expect(await nightlyJob(d)).toBe("partial");
    expect(calls).toEqual(["runNightly", "evening", "notify:evening"]);
    expect(jobs.get(JOB_EVENING)).toMatchObject({ lastRunAt: 123, lastStatus: "ok" });
  });

  it("nightly: no notification once the app is quitting", async () => {
    const { d, calls } = deps({ aborted: () => true });
    await nightlyJob(d);
    expect(calls).toEqual(["runNightly", "evening"]);
  });

  it("nightly: distills memory last, and its failure does not fail the job", async () => {
    const { d, calls } = deps({
      distill: async () => {
        calls.push("distill");
        throw new Error("boom");
      },
    });
    // 批量本身成功：蒸馏失败也不能把结果变成别的（默认的 "partial" 测不出回归）。
    d.runner = {
      ...d.runner,
      runNightly: async () => {
        calls.push("runNightly");
        return { status: "ok", outcomes: [] };
      },
    };
    expect(await nightlyJob(d)).toBe("ok");
    expect(calls).toEqual(["runNightly", "evening", "notify:evening", "distill"]);
  });

  it("nightly: a distill step that throws synchronously does not fail the job either", async () => {
    const { d, calls } = deps({
      distill: () => {
        calls.push("distill");
        throw new Error("sync boom");
      },
    });
    expect(await nightlyJob(d)).toBe("partial");
    expect(calls).toEqual(["runNightly", "evening", "notify:evening", "distill"]);
  });

  it("nightly: records its result without waiting for distillation, and a slow distill does not delay the catch-up morning brief (I1)", async () => {
    let finishDistill: () => void = () => undefined;
    const distilling = new Promise<void>((resolve) => (finishDistill = resolve));
    let distillDone = false;
    const { d, calls } = deps({
      distill: () => {
        calls.push("distill");
        return distilling.then(() => {
          distillDone = true;
        });
      },
    });
    // 2026-10-21（周三）09:00 解锁：上次晚间任务是周一，补跑周二的，然后出早间简报。
    const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
    d.jobs.record(JOB_NIGHTLY, at(19, 16, 5), "ok", null);
    const scheduler = new Scheduler({
      jobs: d.jobs,
      config: () => ({ nightly: { h: 16, m: 0 }, workingDays: new Set([1, 2, 3, 4, 5]) }),
      now: () => at(21, 9),
      userActive: () => false,
      nightly: (slot) => nightlyJob(d, slot),
      morning: async () => void calls.push("morning"),
    });
    await scheduler.check("unlock");
    expect(calls).toEqual(["runNightly", "evening", "distill", "morning"]);
    expect(distillDone).toBe(false);
    expect(d.jobs.get(JOB_NIGHTLY)).toMatchObject({ lastRunAt: at(21, 9), lastStatus: "partial" });
    expect(d.jobs.get(JOB_MORNING)).toMatchObject({ lastRunAt: at(21, 9), lastStatus: "ok" });
    expect(scheduler.isRunning(JOB_NIGHTLY)).toBe(false);
    finishDistill();
    await distilling;
    await Promise.resolve();
    expect(distillDone).toBe(true);
  });

  it("nightly: no distillation once the app is quitting", async () => {
    const { d, calls } = deps({ aborted: () => true, distill: async () => calls.push("distill") });
    await nightlyJob(d);
    expect(calls).not.toContain("distill");
  });

  it("morning: a quick brief from current data first, then refresh and regenerate on working days", async () => {
    const { d, calls } = deps();
    await morningJob(d);
    expect(calls).toEqual(["morning", "refreshing=true", "refresh", "morning", "refreshing=false"]);
  });

  it("morning: no refresh on days off, and the flag is cleared even if refresh fails", async () => {
    const off = deps({ isWorkingDay: () => false });
    await morningJob(off.d);
    expect(off.calls).toEqual(["morning"]);
    const failing = deps();
    failing.d.runner = {
      ...failing.d.runner,
      refreshForBrief: async () => {
        throw new Error("boom");
      },
    };
    await expect(morningJob(failing.d)).rejects.toThrow("boom");
    expect(failing.calls).toEqual(["morning", "refreshing=true", "refreshing=false"]);
  });

  it("turns a synchronous throw from the runner into a rejection and still clears the flag", async () => {
    const boom = () => {
      throw new Error("sync boom");
    };
    const nightly = deps();
    nightly.d.runner = { runNightly: boom, refreshForBrief: boom };
    await expect(nightlyJob(nightly.d)).rejects.toThrow("sync boom");
    expect(nightly.calls).toEqual([]);
    const morning = deps();
    morning.d.runner = { runNightly: boom, refreshForBrief: boom };
    await expect(morningJob(morning.d)).rejects.toThrow("sync boom");
    expect(morning.calls).toEqual(["morning", "refreshing=true", "refreshing=false"]);
  });

  it("nightly: no notification for an empty brief or for catching up an earlier day's slot", async () => {
    const at = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
    const empty = deps({ now: () => at(20, 16) });
    empty.d.briefs = { ...empty.d.briefs, generateEvening: () => brief("evening", false) };
    await nightlyJob(empty.d, at(20, 16));
    expect(empty.calls).toEqual(["runNightly"]);
    const late = deps({ now: () => at(21, 8) });
    await nightlyJob(late.d, at(20, 16));
    expect(late.calls).toEqual(["runNightly", "evening"]);
    const today = deps({ now: () => at(20, 16) });
    await nightlyJob(today.d, at(20, 16));
    expect(today.calls).toEqual(["runNightly", "evening", "notify:evening"]);
    const manual = deps({ now: () => at(17, 11) });
    await nightlyJob(manual.d, null);
    expect(manual.calls).toEqual(["runNightly", "evening", "notify:evening"]);
  });

  it("nightly: a run that starts before midnight still notifies for its own day", async () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
    const times = [at(20, 23, 50), at(21, 0, 5)];
    const late = deps({ now: () => (times.length > 1 ? times.shift()! : times[0]) });
    await nightlyJob(late.d, at(20, 16));
    expect(late.calls).toEqual(["runNightly", "evening", "notify:evening"]);
  });

  it("morning: narrates the final brief once, after the refresh", async () => {
    const r = deps();
    let id = 0;
    const narrated: number[] = [];
    r.d.briefs = {
      ...r.d.briefs,
      generateMorning: () => {
        r.calls.push("morning");
        return { ...brief("morning"), id: ++id };
      },
    };
    r.d.narrate = async (b) => {
      r.calls.push("narrate");
      narrated.push(b.id);
    };
    await morningJob(r.d);
    expect(r.calls).toEqual(["morning", "refreshing=true", "refresh", "morning", "refreshing=false", "narrate"]);
    expect(narrated).toEqual([2]);
  });

  it("morning: still narrates the first brief when the refresh fails, and does not narrate once the app is quitting", async () => {
    const failing = deps();
    failing.d.runner = { ...failing.d.runner, refreshForBrief: async () => Promise.reject(new Error("boom")) };
    failing.d.narrate = async () => void failing.calls.push("narrate");
    await expect(morningJob(failing.d)).rejects.toThrow("boom");
    expect(failing.calls).toEqual(["morning", "refreshing=true", "refreshing=false", "narrate"]);
    const quitting = deps({ aborted: () => true });
    quitting.d.narrate = async () => void quitting.calls.push("narrate");
    await morningJob(quitting.d);
    expect(quitting.calls).not.toContain("narrate");
  });
});

describe("BackgroundRunner (nightly distillation off the scheduler chain)", () => {
  function runner(over: { run?: (signal: AbortSignal) => Promise<unknown>; signal?: AbortSignal } = {}) {
    const logs: string[] = [];
    const ctl = new AbortController();
    const r = new BackgroundRunner({
      name: "memory distill",
      run: over.run ?? (async () => undefined),
      signal: over.signal ?? ctl.signal,
      log: (m, e) => logs.push(e === undefined ? m : `${m} ${e instanceof Error ? e.message : String(e)}`),
    });
    return { r, logs, ctl };
  }

  it("runs one at a time: a start while the previous run is going is skipped with a log line", async () => {
    let finish: () => void = () => undefined;
    let runs = 0;
    const { r, logs } = runner({
      run: () => {
        runs++;
        return new Promise<void>((resolve) => (finish = resolve));
      },
    });
    const first = r.start();
    await Promise.resolve();
    expect(r.running()).toBe(first);
    expect(r.start()).toBe(first);
    expect(logs).toEqual(["memory distill skipped: the previous run is still going"]);
    finish();
    await first;
    expect(runs).toBe(1);
    expect(r.running()).toBeNull();
    // 上一次结束之后可以再跑。
    const second = r.start();
    await Promise.resolve();
    finish();
    await second;
    expect(runs).toBe(2);
  });

  it("only logs a failure, sync or async, and never rejects", async () => {
    const async = runner({ run: async () => Promise.reject(new Error("boom")) });
    await expect(async.r.start()).resolves.toBeUndefined();
    expect(async.logs).toEqual(["memory distill failed boom"]);
    const sync = runner({
      run: () => {
        throw new Error("sync boom");
      },
    });
    await expect(sync.r.start()).resolves.toBeUndefined();
    expect(sync.logs).toEqual(["memory distill failed sync boom"]);
    expect(sync.r.running()).toBeNull();
  });

  it("hands its quit signal to the run, and starts nothing once quitting", async () => {
    const seen: AbortSignal[] = [];
    const { r, ctl } = runner({ run: async (signal) => void seen.push(signal) });
    await r.start();
    expect(seen).toEqual([ctl.signal]);
    ctl.abort();
    await r.start();
    expect(seen).toHaveLength(1);
  });
});
