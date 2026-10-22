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
  /** 晚间小结之后：full 档位下蒸馏 StateCore 记忆（MemoryService.distill，计划 4 R1）。失败不影响晚间任务。 */
  distill?: () => Promise<unknown>;
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
  // 最后一步：蒸馏的失败（包括同步抛错）只到这里为止，晚间任务的结果、handoff 和小结都不受影响。
  if (d.distill && !d.aborted?.()) {
    const distill = d.distill;
    await Promise.resolve()
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
