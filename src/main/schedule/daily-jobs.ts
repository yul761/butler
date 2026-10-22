import type { Brief } from "../../shared/brief";
import type { BriefService } from "../brief/brief-service";
import { localDate } from "./calendar";
import { JOB_EVENING, type JobsRepo } from "../db/jobs-repo";
import type { HandoffRunner } from "../handoff/runner";

export interface DailyJobDeps {
  runner: Pick<HandoffRunner, "runNightly" | "refreshForBrief">;
  briefs: Pick<BriefService, "generateMorning" | "generateEvening">;
  jobs: JobsRepo;
  now: () => number;
  isWorkingDay: () => boolean;
  /** 早间刷新进行中（界面显示“刷新中”）。 */
  setRefreshing: (v: boolean) => void;
  /** 晚间小结生成后：弹系统通知。 */
  onEvening: (brief: Brief) => void;
  /** 早间：最终的简报入库之后补“今日重点”（narrateBrief，永远不抛错）。没有配置时不传。 */
  narrate?: (brief: Brief) => Promise<unknown>;
  /**
   * 晚间小结之后：在后台开始 full 档位的 StateCore 蒸馏（主进程里是 BackgroundRunner.start → nightlyDistill，计划 4 R1）。
   * 不等它结束，失败不影响晚间任务。
   */
  distill?: () => unknown;
  /** 退出已开始：不再通知、不再发起新工作。 */
  aborted?: () => boolean;
}

/** 晚间：批量 handoff → 晚间小结 → 系统通知 → 记忆蒸馏（full 档位）。 */
export async function nightlyJob(d: DailyJobDeps, slot?: number | null): Promise<"ok" | "partial"> {
  // 用开始时间判断“是不是今天的时刻”：批量跑过午夜也照常通知。
  const startedAt = d.now();
  // runner 的方法不是 async，可能同步抛错：包一层，让它变成 rejection 由调度器记录。
  const batch = await Promise.resolve().then(() => d.runner.runNightly());
  const brief = d.briefs.generateEvening();
  d.jobs.record(JOB_EVENING, d.now(), "ok", null);
  // 只在有内容、且跑的是今天的晚间时刻时通知；补跑以前日期的时刻不弹，早间简报里会看到。
  const forToday = slot === undefined || slot === null || localDate(slot) === localDate(startedAt);
  if (brief.evening.length > 0 && forToday && !d.aborted?.()) d.onEvening(brief);
  // 最后一步，不 await（审查 I1）：蒸馏可能要很多次 LLM 调用，不能挡住调度的串行链——
  // 晚间任务的结果要先记下，补跑时紧接着的早间简报不用等整轮蒸馏。但“今日重点”和蒸馏共用 gateway 的串行链：
  // 早间的 narrate 可能要排在一个正在进行的 StateCore 调用后面，最多等这一个调用（上限 180 秒），不会等整轮（最终审查 10，接受）。
  // 失败（包括同步抛错）只到这里为止。
  if (d.distill && !d.aborted?.()) {
    const distill = d.distill;
    void Promise.resolve()
      .then(() => distill())
      .catch(() => undefined);
  }
  return batch.status;
}

/**
 * 早间：先用现有数据出一版（界面马上有内容），工作日再刷新 PR / tracker 状态后原地更新；
 * 最后对最终的那一版补“今日重点”。刷新失败也会给第一版补上，然后照常把错误交给调度器。
 */
export async function morningJob(d: DailyJobDeps): Promise<void> {
  let brief = d.briefs.generateMorning();
  try {
    if (d.isWorkingDay()) {
      d.setRefreshing(true);
      try {
        const r = await Promise.resolve().then(() => d.runner.refreshForBrief());
        if (r.outcomes.length > 0) brief = d.briefs.generateMorning();
      } finally {
        d.setRefreshing(false);
      }
    }
  } finally {
    if (d.narrate && !d.aborted?.()) await d.narrate(brief);
  }
}

/**
 * 不占调度串行链的后台任务（晚间任务之后的记忆蒸馏）。同时只跑一次：上一次还没结束时跳过，记一行日志。
 * signal（退出时 abort）交给任务本身，abort 之后不再开始新的。失败只写日志，start() 返回的 promise 永不 reject。
 */
export class BackgroundRunner {
  private current: Promise<void> | null = null;

  constructor(
    private readonly d: { name: string; run: (signal: AbortSignal) => Promise<unknown>; signal: AbortSignal; log: (msg: string, err?: unknown) => void },
  ) {}

  private log(msg: string, err?: unknown): void {
    try {
      this.d.log(msg, err);
    } catch {
      // 写日志失败不能变成未处理的 rejection。
    }
  }

  start(): Promise<void> {
    if (this.d.signal.aborted) return Promise.resolve();
    if (this.current) {
      this.log(`${this.d.name} skipped: the previous run is still going`);
      return this.current;
    }
    const p = Promise.resolve()
      .then(() => this.d.run(this.d.signal))
      .then(
        () => undefined,
        (e: unknown) => this.log(`${this.d.name} failed`, e),
      )
      .finally(() => {
        this.current = null;
      });
    this.current = p;
    return p;
  }

  /** 正在跑的那一次（handle）；没有时为 null。 */
  running(): Promise<void> | null {
    return this.current;
  }
}
