import type { FeatureSummaryRunner } from "../handoff/feature-runner";
import type { HandoffRunner } from "../handoff/runner";

export interface DailyJobDeps {
  runner: Pick<HandoffRunner, "runNightly" | "refreshForBrief">;
  /** feature 汇总（设计文档 2026-10-28）：ticket 批次跑完之后逐个跑 feature。没有时不跑。 */
  features?: Pick<FeatureSummaryRunner, "runNightly">;
  isWorkingDay: () => boolean;
  /** 配了 tracker 工具（和 HandoffRunner 的 allowedTools 用同一个 trackerTools）。PR 状态由 PrWatcher 跟着，早间刷新只为 tracker 而跑。 */
  hasTrackerTools: () => boolean;
  /** 退出已开始：不再发起新工作。 */
  aborted?: () => boolean;
  /** 写日志（feature 批次出错时用）；没有时不记。 */
  log?: (msg: string, err?: unknown) => void;
}

/** 晚间：批量 handoff → feature 汇总。 */
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
      // feature 批次出错（包括同步抛错）不能挡住后面的步骤：记一笔，批次记为 partial，照常往下走。
      try {
        if ((await Promise.resolve().then(() => features.runNightly())).status === "partial") status = "partial";
      } catch (e) {
        status = "partial";
        try {
          d.log?.("nightly feature summaries failed", e);
        } catch {
          // 写日志失败也不能挡住后面的步骤。
        }
      }
    }
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
