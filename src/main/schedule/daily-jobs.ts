import type { EpicDigestRunner } from "../epics/epic-digest";
import type { FeatureSummaryRunner } from "../handoff/feature-runner";
import type { HandoffRunner } from "../handoff/runner";

export interface DailyJobDeps {
  runner: Pick<HandoffRunner, "runNightly" | "refreshForBrief">;
  /** feature 汇总（设计文档 2026-10-28）：ticket 批次跑完之后逐个跑 feature。没有时不跑。 */
  features?: Pick<FeatureSummaryRunner, "runNightly">;
  isWorkingDay: () => boolean;
  /** 配了 tracker 工具（和 HandoffRunner 的 allowedTools 用同一个 trackerTools）。PR 状态由 PrWatcher 跟着，早间刷新只为 tracker 而跑。 */
  hasTrackerTools: () => boolean;
  /**
   * 批次跑完之后：在后台开始 full 档位的 StateCore 蒸馏（主进程里是 BackgroundRunner.start → nightlyDistill，计划 4 R1）。
   * 不等它结束，失败不影响晚间任务。
   */
  distill?: () => unknown;
  /** epic 的每周整理（计划 16 任务 6）：只在这一周的第一个工作日跑；不等它，失败只记日志。没有时不跑。 */
  epicDigest?: Pick<EpicDigestRunner, "weekly">;
  /** 今天是不是这一周的第一个工作日（calendar 的 isFirstWorkingDayOfWeek）。没有时当作不是。 */
  isFirstWorkingDayOfWeek?: () => boolean;
  /** 退出已开始：不再发起新工作。 */
  aborted?: () => boolean;
  /** 写日志（feature 批次出错时用）；没有时不记。 */
  log?: (msg: string, err?: unknown) => void;
}

/** 写日志失败不能让晚间任务出错。 */
function safeLog(d: DailyJobDeps, msg: string, err?: unknown): void {
  try {
    d.log?.(msg, err);
  } catch {
    // 忽略。
  }
}

/** 晚间：批量 handoff → feature 汇总 → 记忆蒸馏（full 档位）→ 每周第一个工作日的 epic 整理。 */
export async function nightlyJob(d: DailyJobDeps): Promise<"ok" | "partial"> {
  // runner 的方法不是 async，可能同步抛错：包一层，让它变成 rejection 由调度器记录。
  const batch = await Promise.resolve().then(() => d.runner.runNightly());
  let status = batch.status;
  // feature 汇总放在 ticket 批次的末尾（失败、跳过的也算跑完）。ticket 批次被限流时不再跑任何 feature：
  // 再发起只会接着被限流，批次记为 partial，早间补跑。
  const features = d.features;
  if (features) {
    const limited = batch.outcomes.some((o) => o.status === "skipped" && o.reason === "rate_limited");
    if (limited) status = "partial";
    else {
      // feature 批次出错（包括同步抛错）不能挡住记忆蒸馏：记一笔，批次记为 partial，照常往下走。
      try {
        if ((await Promise.resolve().then(() => features.runNightly())).status === "partial") status = "partial";
      } catch (e) {
        status = "partial";
        try {
          d.log?.("nightly feature summaries failed", e);
        } catch {
          // 写日志失败也不能挡住记忆蒸馏。
        }
      }
    }
  }
  // 最后一步，不 await（审查 I1）：蒸馏可能要很多次 LLM 调用，不能挡住调度的串行链——
  // 晚间任务的结果要先记下，补跑时紧接着的早间任务不用等整轮蒸馏。失败（包括同步抛错）只到这里为止。
  if (d.distill && !d.aborted?.()) {
    const distill = d.distill;
    void Promise.resolve()
      .then(() => distill())
      .catch(() => undefined);
  }
  // epic 的每周整理也不 await：要跑好几次 Sonnet，不能挡住调度链。同一周不会整理两次由它自己保证（见 EpicDigestRunner.weekly）。
  // 判断今天是不是第一个工作日也放进去：读设置出错同样只记日志。
  if (d.epicDigest && !d.aborted?.()) {
    const digest = d.epicDigest;
    void Promise.resolve()
      .then(() => (d.isFirstWorkingDayOfWeek?.() ? digest.weekly() : undefined))
      .catch((e: unknown) => safeLog(d, "weekly epic digest failed", e));
  }
  return status;
}

/**
 * 早间：工作日、配了 tracker 工具时刷新一次 tracker 状态（PR 状态 PrWatcher 一直跟着，没配 tracker 工具就不用再跑一次 claude）。
 * 刷新失败照常把错误交给调度器。
 */
export async function morningJob(d: DailyJobDeps): Promise<void> {
  if (!d.isWorkingDay() || !d.hasTrackerTools()) return;
  await Promise.resolve().then(() => d.runner.refreshForBrief());
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
