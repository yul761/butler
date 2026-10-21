import { JOB_MORNING, JOB_NIGHTLY, type JobsRepo, type JobState } from "../db/jobs-repo";
import type { ScheduleConfig } from "../settings/settings-values";
import { addDays, atTime, localDate, weekday } from "./calendar";

export type ScheduleTrigger = "startup" | "resume" | "unlock" | "tick";

/** 凌晨 5 点前的解锁/启动不算“早上”。 */
export const MORNING_EARLIEST_HOUR = 5;
export const TICK_MS = 60_000;

/** 不晚于 now 的最近一个工作日的晚间时刻；最近 8 天都不是工作日时为 null。 */
export function lastNightlySlot(now: number, cfg: ScheduleConfig): number | null {
  const today = localDate(now);
  for (let i = 0; i <= 7; i++) {
    const date = addDays(today, -i);
    if (!cfg.workingDays.has(weekday(date))) continue;
    const slot = atTime(date, cfg.nightly.h, cfg.nightly.m);
    if (slot <= now) return slot;
  }
  return null;
}

/** 每天第一次 startup / resume / unlock（5 点以后）；tick 只在用户正在用电脑时算数（整晚没锁屏的情况）。 */
export function isMorningDue(now: number, job: Pick<JobState, "lastRunAt">, trigger: ScheduleTrigger, userActive: boolean): boolean {
  if (new Date(now).getHours() < MORNING_EARLIEST_HOUR) return false;
  if (job.lastRunAt !== null && localDate(job.lastRunAt) === localDate(now)) return false;
  return trigger !== "tick" || userActive;
}

/**
 * 最近一个晚间时刻之后还没跑过 → 到期（错过的会在下一次唤醒/解锁/启动时补跑）。
 * 上次限流或失败 → 在早间简报之前再补一次。第一次启动（从没记录）不补历史。
 */
export function isNightlyDue(now: number, cfg: ScheduleConfig, job: Pick<JobState, "lastRunAt" | "lastStatus">, morningDue: boolean): boolean {
  if (job.lastRunAt === null) return false;
  // 上次运行时间在一天以后：时钟被往回校正过，当作到期，免得整段时间都不跑。
  if (job.lastRunAt - now > 86_400_000) return true;
  const slot = lastNightlySlot(now, cfg);
  if (slot !== null && job.lastRunAt < slot) return true;
  return morningDue && (job.lastStatus === "partial" || job.lastStatus === "failed");
}

export interface SchedulerDeps {
  jobs: JobsRepo;
  config: () => ScheduleConfig;
  now: () => number;
  userActive: () => boolean;
  /** slot：这次补跑 / 执行对应的晚间时刻（没有工作日时为 null）。 */
  nightly: (slot: number | null) => Promise<"ok" | "partial">;
  morning: () => Promise<void>;
  onChange?: () => void;
  log?: (msg: string, err?: unknown) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Scheduler {
  private chain: Promise<void> = Promise.resolve();
  private readonly running = new Set<string>();

  constructor(private readonly d: SchedulerDeps) {}

  isRunning(job: typeof JOB_NIGHTLY | typeof JOB_MORNING): boolean {
    return this.running.has(job);
  }

  /** 串行执行：同时到来的事件排队，轮到时重新判断是否到期，所以同一个任务不会重复跑。 */
  check(trigger: ScheduleTrigger): Promise<void> {
    return this.enqueue(() => this.evaluate(trigger));
  }

  runNightlyNow(): Promise<void> {
    return this.enqueue(() => this.runNightly());
  }

  runMorningNow(): Promise<void> {
    return this.enqueue(() => this.runMorning());
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn).catch((e: unknown) => this.d.log?.("scheduler step failed", e));
    this.chain = next;
    return next;
  }

  private async evaluate(trigger: ScheduleTrigger): Promise<void> {
    const now = this.d.now();
    if (this.d.jobs.get(JOB_NIGHTLY).lastRunAt === null) this.d.jobs.record(JOB_NIGHTLY, now, "seeded", null);
    const morningDue = isMorningDue(now, this.d.jobs.get(JOB_MORNING), trigger, this.d.userActive());
    // 错过的晚间 handoff 先跑，早间简报才有最新数据。
    if (isNightlyDue(now, this.d.config(), this.d.jobs.get(JOB_NIGHTLY), morningDue)) await this.runNightly();
    if (morningDue) await this.runMorning();
  }

  private async runNightly(): Promise<void> {
    const startedAt = this.d.now();
    const slot = lastNightlySlot(startedAt, this.d.config());
    await this.track(
      JOB_NIGHTLY,
      async () => this.d.jobs.record(JOB_NIGHTLY, startedAt, await Promise.resolve().then(() => this.d.nightly(slot)), null),
      (e) => this.d.jobs.record(JOB_NIGHTLY, startedAt, "failed", message(e)),
    );
  }

  private async runMorning(): Promise<void> {
    const startedAt = this.d.now();
    await this.track(
      JOB_MORNING,
      async () => {
        await Promise.resolve().then(() => this.d.morning());
        this.d.jobs.record(JOB_MORNING, startedAt, "ok", null);
      },
      (e) => this.d.jobs.record(JOB_MORNING, startedAt, "failed", message(e)),
    );
  }

  private async track(name: string, fn: () => Promise<void>, onError: (e: unknown) => void): Promise<void> {
    this.running.add(name);
    this.d.onChange?.();
    try {
      await fn();
    } catch (e) {
      this.d.log?.(`${name} failed`, e);
      onError(e);
    } finally {
      this.running.delete(name);
      this.d.onChange?.();
    }
  }
}
