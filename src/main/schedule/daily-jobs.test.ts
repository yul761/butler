import { describe, expect, it } from "vitest";
import { JOB_MORNING, JOB_NIGHTLY, JobsRepo } from "../db/jobs-repo";
import { memDb } from "../test-utils";
import { BackgroundRunner, morningJob, nightlyJob, type DailyJobDeps } from "./daily-jobs";
import { Scheduler } from "./scheduler";

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
    isWorkingDay: () => true,
    hasTrackerTools: () => true,
    ...over,
  };
  return { d, calls, jobs };
}

describe("daily jobs", () => {
  it("nightly: just the handoff batch, no evening summary or notification", async () => {
    const { d, calls } = deps();
    expect(await nightlyJob(d)).toBe("partial");
    expect(calls).toEqual(["runNightly"]);
  });

  describe("feature summaries", () => {
    const okTickets = (calls: string[], outcomes: Awaited<ReturnType<DailyJobDeps["runner"]["runNightly"]>>["outcomes"] = []) => ({
      runNightly: async () => {
        calls.push("runNightly");
        return { status: "ok" as const, outcomes };
      },
      refreshForBrief: async () => ({ status: "ok" as const, outcomes: [] }),
    });
    const featureRunner = (calls: string[], status: "ok" | "partial" = "ok") => ({
      runNightly: async () => {
        calls.push("features");
        return { status, outcomes: [] };
      },
    });

    it("runs after the ticket batch", async () => {
      const { d, calls } = deps();
      d.runner = okTickets(calls);
      d.features = featureRunner(calls);
      expect(await nightlyJob(d)).toBe("ok");
      expect(calls).toEqual(["runNightly", "features"]);
    });

    it("is skipped when the ticket batch was rate limited, and the job is partial", async () => {
      const { d, calls } = deps();
      d.runner = okTickets(calls, [
        { ticketKey: "A-1", status: "stored", handoffId: 1, degraded: false },
        { ticketKey: "A-2", status: "skipped", reason: "rate_limited" },
      ]);
      d.features = featureRunner(calls);
      expect(await nightlyJob(d)).toBe("partial");
      expect(calls).toEqual(["runNightly"]);
    });

    it("a partial feature batch makes the job partial", async () => {
      const { d, calls } = deps();
      d.runner = okTickets(calls);
      d.features = featureRunner(calls, "partial");
      expect(await nightlyJob(d)).toBe("partial");
      expect(calls).toEqual(["runNightly", "features"]);
    });

    it("a partial ticket batch (not rate limited) still runs the features and stays partial", async () => {
      const { d, calls } = deps();
      d.features = featureRunner(calls);
      expect(await nightlyJob(d)).toBe("partial");
      expect(calls).toEqual(["runNightly", "features"]);
    });

    it("a feature batch that rejects or throws only logs: distillation still starts, and the job is partial", async () => {
      for (const fail of ["reject", "throw"] as const) {
        const { d, calls } = deps();
        const logs: [string, unknown][] = [];
        d.runner = okTickets(calls);
        d.log = (msg, err) => void logs.push([msg, err]);
        d.distill = () => calls.push("distill");
        const boom = new Error("db locked");
        d.features = {
          runNightly: () => {
            calls.push("features");
            if (fail === "throw") throw boom;
            return Promise.reject(boom);
          },
        };
        expect(await nightlyJob(d)).toBe("partial");
        await Promise.resolve();
        expect(calls).toEqual(["runNightly", "features", "distill"]);
        expect(logs).toEqual([["nightly feature summaries failed", boom]]);
      }
    });

    it("a feature batch failure without a log function is still only partial", async () => {
      const { d, calls } = deps();
      d.runner = okTickets(calls);
      d.features = { runNightly: () => Promise.reject(new Error("x")) };
      expect(await nightlyJob(d)).toBe("partial");
      expect(calls).toEqual(["runNightly"]);
    });

    it("without features the job is unchanged", async () => {
      const { d, calls } = deps();
      d.runner = okTickets(calls);
      expect(await nightlyJob(d)).toBe("ok");
      expect(calls).toEqual(["runNightly"]);
    });
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
    expect(calls).toEqual(["runNightly", "distill"]);
  });

  describe("weekly epic digest (plan 16 task 6, R32)", () => {
    it("asks for the weekly digest after every nightly run on a working day (the runner decides which epics are due)", async () => {
      for (const working of [true, false]) {
        const { d, calls } = deps({ isWorkingDay: () => working });
        d.epicDigest = { weekly: async () => void calls.push("weekly") };
        await nightlyJob(d);
        expect(calls, String(working)).toEqual(working ? ["runNightly", "weekly"] : ["runNightly"]);
      }
    });

    it("does not wait for it, and a failure only logs", async () => {
      for (const fail of ["reject", "throw"] as const) {
        const { d, calls } = deps();
        const logs: [string, unknown][] = [];
        d.log = (msg, err) => void logs.push([msg, err]);
        const boom = new Error("boom");
        let finish: () => void = () => undefined;
        d.epicDigest = {
          weekly: () => {
            calls.push("weekly");
            if (fail === "throw") throw boom;
            return new Promise<void>((_, reject) => (finish = () => reject(boom)));
          },
        };
        expect(await nightlyJob(d)).toBe("partial");
        expect(calls).toEqual(["runNightly", "weekly"]);
        finish();
        await new Promise((r) => setTimeout(r, 0));
        expect(logs).toEqual([["weekly epic digest failed", boom]]);
      }
    });

    it("is not started once quitting has begun", async () => {
      const { d, calls } = deps({ aborted: () => true });
      d.epicDigest = { weekly: async () => void calls.push("weekly") };
      await nightlyJob(d);
      expect(calls).toEqual(["runNightly"]);
    });
  });

  it("nightly: a distill step that throws synchronously does not fail the job either", async () => {
    const { d, calls } = deps({
      distill: () => {
        calls.push("distill");
        throw new Error("sync boom");
      },
    });
    expect(await nightlyJob(d)).toBe("partial");
    expect(calls).toEqual(["runNightly", "distill"]);
  });

  it("nightly: records its result without waiting for distillation, and a slow distill does not delay the catch-up morning job (I1)", async () => {
    let finishDistill: () => void = () => undefined;
    const distilling = new Promise<void>((resolve) => (finishDistill = resolve));
    let distillDone = false;
    const { d, calls, jobs } = deps({
      distill: () => {
        calls.push("distill");
        return distilling.then(() => {
          distillDone = true;
        });
      },
    });
    // 2026-10-21（周三）09:00 解锁：上次晚间任务是周一，补跑周二的，然后跑早间任务。
    const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
    jobs.record(JOB_NIGHTLY, at(19, 16, 5), "ok", null);
    const scheduler = new Scheduler({
      jobs,
      config: () => ({ nightly: { h: 16, m: 0 }, workingDays: new Set([1, 2, 3, 4, 5]) }),
      now: () => at(21, 9),
      userActive: () => false,
      nightly: () => nightlyJob(d),
      morning: async () => void calls.push("morning"),
    });
    await scheduler.check("unlock");
    expect(calls).toEqual(["runNightly", "distill", "morning"]);
    expect(distillDone).toBe(false);
    expect(jobs.get(JOB_NIGHTLY)).toMatchObject({ lastRunAt: at(21, 9), lastStatus: "partial" });
    expect(jobs.get(JOB_MORNING)).toMatchObject({ lastRunAt: at(21, 9), lastStatus: "ok" });
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

  it("morning: refreshes tracker state on working days when tracker tools are configured", async () => {
    const { d, calls } = deps();
    await morningJob(d);
    expect(calls).toEqual(["refresh"]);
  });

  it("morning: nothing to do without tracker tools (PR state comes from the watcher) or on days off", async () => {
    const noTools = deps({ hasTrackerTools: () => false });
    await morningJob(noTools.d);
    expect(noTools.calls).toEqual([]);
    const off = deps({ isWorkingDay: () => false });
    await morningJob(off.d);
    expect(off.calls).toEqual([]);
  });

  it("morning: a failing refresh is handed to the scheduler", async () => {
    const failing = deps();
    failing.d.runner = {
      ...failing.d.runner,
      refreshForBrief: async () => {
        throw new Error("boom");
      },
    };
    await expect(morningJob(failing.d)).rejects.toThrow("boom");
  });

  it("turns a synchronous throw from the runner into a rejection", async () => {
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
