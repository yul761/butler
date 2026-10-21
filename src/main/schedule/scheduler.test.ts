import { describe, expect, it } from "vitest";
import { JOB_MORNING, JOB_NIGHTLY, JobsRepo } from "../db/jobs-repo";
import { memDb } from "../test-utils";
import { localDate } from "./calendar";
import { isMorningDue, isNightlyDue, lastNightlySlot, Scheduler } from "./scheduler";

/** 2026 年 10 月：16 日周五，17 日周六，19 日周一，20 日周二，21 日周三。 */
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const cfg = { nightly: { h: 16, m: 0 }, workingDays: new Set([1, 2, 3, 4, 5]) };

describe("lastNightlySlot", () => {
  it("finds the latest working-day slot at or before now", () => {
    expect(lastNightlySlot(at(20, 17), cfg)).toBe(at(20, 16));
    expect(lastNightlySlot(at(20, 15), cfg)).toBe(at(19, 16));
    expect(lastNightlySlot(at(19, 10), cfg)).toBe(at(16, 16));
    expect(lastNightlySlot(at(17, 20), cfg)).toBe(at(16, 16));
    expect(lastNightlySlot(at(20, 17), { ...cfg, workingDays: new Set<number>() })).toBeNull();
  });
});

describe("isNightlyDue / isMorningDue", () => {
  it("runs the nightly batch once per slot, never on first launch, and retries a partial run before the morning brief", () => {
    expect(isNightlyDue(at(20, 16, 1), cfg, { lastRunAt: at(19, 16, 5), lastStatus: "ok" }, false)).toBe(true);
    expect(isNightlyDue(at(20, 17), cfg, { lastRunAt: at(20, 16, 1), lastStatus: "ok" }, false)).toBe(false);
    expect(isNightlyDue(at(20, 17), cfg, { lastRunAt: null, lastStatus: null }, true)).toBe(false);
    expect(isNightlyDue(at(21, 9), cfg, { lastRunAt: at(19, 16), lastStatus: "ok" }, true)).toBe(true);
    expect(isNightlyDue(at(21, 9), cfg, { lastRunAt: at(20, 16), lastStatus: "partial" }, true)).toBe(true);
    expect(isNightlyDue(at(21, 9), cfg, { lastRunAt: at(20, 16), lastStatus: "failed" }, true)).toBe(true);
    expect(isNightlyDue(at(21, 9), cfg, { lastRunAt: at(20, 16), lastStatus: "partial" }, false)).toBe(false);
    expect(isNightlyDue(at(17, 20), cfg, { lastRunAt: at(16, 16), lastStatus: "ok" }, false)).toBe(false);
    // 时钟被往回校正了好几天：上次运行时间在“未来”，当作到期。
    expect(isNightlyDue(at(20, 17), cfg, { lastRunAt: at(25, 16), lastStatus: "ok" }, false)).toBe(true);
  });

  it("runs the morning brief once per day after 5:00, on events, or on a tick while the user is active", () => {
    const yesterday = { lastRunAt: at(20, 9) };
    expect(isMorningDue(at(21, 9), yesterday, "unlock", false)).toBe(true);
    expect(isMorningDue(at(21, 9), { lastRunAt: at(21, 8) }, "unlock", false)).toBe(false);
    expect(isMorningDue(at(21, 4), yesterday, "startup", true)).toBe(false);
    expect(isMorningDue(at(21, 9), yesterday, "tick", false)).toBe(false);
    expect(isMorningDue(at(21, 9), yesterday, "tick", true)).toBe(true);
    expect(isMorningDue(at(21, 9), { lastRunAt: null }, "startup", false)).toBe(true);
  });
});

describe("isNightlyDue on non-working days", () => {
  it("does not catch up or retry on a weekend, but catches up on Monday before the morning brief", () => {
    // 周五 16:00 错过，周六解锁：不跑。
    expect(isNightlyDue(at(17, 10), cfg, { lastRunAt: at(15, 16, 1), lastStatus: "ok" }, true)).toBe(false);
    expect(isNightlyDue(at(17, 10), cfg, { lastRunAt: at(16, 16, 1), lastStatus: "partial" }, true)).toBe(false);
    // 周一解锁 / 启动：补周五。
    expect(isNightlyDue(at(19, 9), cfg, { lastRunAt: at(15, 16, 1), lastStatus: "ok" }, true)).toBe(true);
  });

  it("a Saturday unlock leaves the nightly job alone and Monday's unlock runs it before the morning brief", async () => {
    const log: string[] = [];
    const jobs = new JobsRepo(memDb());
    jobs.record(JOB_NIGHTLY, at(15, 16, 1), "ok", null);
    let now = at(17, 10);
    const scheduler = new Scheduler({
      jobs, config: () => cfg, now: () => now, userActive: () => true,
      nightly: async () => {
        log.push("nightly");
        return "ok";
      },
      morning: async () => {
        log.push("morning");
      },
    });
    await scheduler.check("unlock");
    expect(log).toEqual(["morning"]);
    now = at(19, 9);
    await scheduler.check("unlock");
    expect(log).toEqual(["morning", "nightly", "morning"]);
  });
});

describe("Scheduler", () => {
  function setup(start: number) {
    let now = start;
    let nightlyStatus: "ok" | "partial" = "ok";
    const jobs = new JobsRepo(memDb());
    const log: string[] = [];
    const scheduler = new Scheduler({
      jobs, config: () => cfg, now: () => now, userActive: () => true,
      nightly: async () => {
        log.push(`nightly@${localDate(now)}`);
        return nightlyStatus;
      },
      morning: async () => {
        log.push(`morning@${localDate(now)}`);
      },
    });
    return {
      scheduler, jobs, log,
      setNow: (ms: number) => void (now = ms),
      setNightlyStatus: (s: "ok" | "partial") => void (nightlyStatus = s),
    };
  }

  it("seeds on first launch, runs the morning brief, then the nightly batch at 16:00", async () => {
    const s = setup(at(20, 9));
    await s.scheduler.check("startup");
    expect(s.log).toEqual(["morning@2026-10-20"]);
    expect(s.jobs.get(JOB_NIGHTLY).lastStatus).toBe("seeded");
    for (const [h, m] of [[15, 59], [16, 0], [16, 1]]) {
      s.setNow(at(20, h, m));
      await s.scheduler.check("tick");
    }
    expect(s.log).toEqual(["morning@2026-10-20", "nightly@2026-10-20"]);
    expect(s.jobs.get(JOB_NIGHTLY)).toMatchObject({ lastRunAt: at(20, 16), lastStatus: "ok" });
  });

  it("catches up a missed nightly run before the morning brief after the laptop slept", async () => {
    const s = setup(at(19, 9));
    await s.scheduler.check("startup");
    s.setNow(at(21, 8, 30));
    await s.scheduler.check("resume");
    expect(s.log).toEqual(["morning@2026-10-19", "nightly@2026-10-21", "morning@2026-10-21"]);
    await s.scheduler.check("unlock");
    expect(s.log).toHaveLength(3);
  });

  it("retries a partial nightly batch once before the next morning brief", async () => {
    const s = setup(at(20, 9));
    await s.scheduler.check("startup");
    s.setNightlyStatus("partial");
    s.setNow(at(20, 16));
    await s.scheduler.check("tick");
    s.setNightlyStatus("ok");
    s.setNow(at(21, 9));
    await s.scheduler.check("unlock");
    await s.scheduler.check("tick");
    expect(s.log).toEqual(["morning@2026-10-20", "nightly@2026-10-20", "nightly@2026-10-21", "morning@2026-10-21"]);
  });

  it("skips weekends and serialises triggers that arrive together", async () => {
    const s = setup(at(16, 17));
    await s.scheduler.check("startup");
    s.setNow(at(17, 16, 30));
    await Promise.all([s.scheduler.check("tick"), s.scheduler.check("unlock"), s.scheduler.check("resume")]);
    expect(s.log).toEqual(["morning@2026-10-16", "morning@2026-10-17"]);
  });

  it("records failures and reports a job as running only while it runs", async () => {
    let seen = false;
    const jobs = new JobsRepo(memDb());
    const scheduler: Scheduler = new Scheduler({
      jobs, config: () => cfg, now: () => at(20, 17), userActive: () => true,
      nightly: async () => {
        seen = scheduler.isRunning(JOB_NIGHTLY);
        throw new Error("claude 不见了");
      },
      morning: async () => undefined,
    });
    await scheduler.runNightlyNow();
    expect(seen).toBe(true);
    expect(scheduler.isRunning(JOB_NIGHTLY)).toBe(false);
    expect(jobs.get(JOB_NIGHTLY)).toMatchObject({ lastRunAt: at(20, 17), lastStatus: "failed", lastError: "claude 不见了" });
  });

  it("passes a null slot (meaning today) for a manual run, so a weekend run still notifies", async () => {
    const slots: (number | null)[] = [];
    const scheduler = new Scheduler({
      jobs: new JobsRepo(memDb()), config: () => cfg, now: () => at(17, 11), userActive: () => true,
      nightly: async (slot) => {
        slots.push(slot);
        return "ok";
      },
      morning: async () => undefined,
    });
    await scheduler.runNightlyNow();
    expect(slots).toEqual([null]);
  });

  it("two manual runs of the same job share one run (nightly and morning)", async () => {
    let nightly = 0;
    let morning = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const scheduler = new Scheduler({
      jobs: new JobsRepo(memDb()), config: () => cfg, now: () => at(20, 17), userActive: () => true,
      nightly: async () => {
        nightly++;
        await gate;
        return "ok";
      },
      morning: async () => {
        morning++;
        await gate;
      },
    });
    const a = scheduler.runNightlyNow();
    const b = scheduler.runNightlyNow();
    const c = scheduler.runMorningNow();
    const d = scheduler.runMorningNow();
    expect(b).toBe(a);
    expect(d).toBe(c);
    release();
    await Promise.all([a, b, c, d]);
    expect([nightly, morning]).toEqual([1, 1]);
    // 跑完以后可以再手动跑一次。
    await scheduler.runNightlyNow();
    expect(nightly).toBe(2);
  });

  it("a manual run while the scheduled run is in flight joins it instead of starting another", async () => {
    let nightly = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const jobs = new JobsRepo(memDb());
    jobs.record(JOB_NIGHTLY, at(19, 16, 1), "ok", null);
    const scheduler = new Scheduler({
      jobs, config: () => cfg, now: () => at(20, 17), userActive: () => true,
      nightly: async () => {
        nightly++;
        await gate;
        return "ok";
      },
      morning: async () => undefined,
    });
    const scheduled = scheduler.check("tick");
    await Promise.resolve();
    expect(scheduler.isRunning(JOB_NIGHTLY)).toBe(true);
    const manual = scheduler.runNightlyNow();
    release();
    await Promise.all([scheduled, manual]);
    expect(nightly).toBe(1);
  });

  it("records a synchronous throw from the jobs and keeps scheduling", async () => {
    const jobs = new JobsRepo(memDb());
    const boom = () => {
      throw new Error("sync boom");
    };
    const scheduler = new Scheduler({
      jobs, config: () => cfg, now: () => at(20, 17), userActive: () => true,
      nightly: boom as unknown as () => Promise<"ok">,
      morning: boom as unknown as () => Promise<void>,
    });
    await scheduler.runNightlyNow();
    await scheduler.runMorningNow();
    expect(jobs.get(JOB_NIGHTLY)).toMatchObject({ lastStatus: "failed", lastError: "sync boom" });
    expect(jobs.get(JOB_MORNING)).toMatchObject({ lastStatus: "failed", lastError: "sync boom" });
    expect(scheduler.isRunning(JOB_NIGHTLY)).toBe(false);
  });

  it("never runs the nightly batch twice in a day, even if the clock moves back an hour (timezone change)", async () => {
    const s = setup(at(20, 9));
    await s.scheduler.check("startup");
    s.setNow(at(20, 16, 30));
    await s.scheduler.check("tick");
    s.setNow(at(20, 15, 30));
    await s.scheduler.check("resume");
    s.setNow(at(20, 16, 45));
    await s.scheduler.check("unlock");
    expect(s.log.filter((l) => l.startsWith("nightly"))).toEqual(["nightly@2026-10-20"]);
  });
});
