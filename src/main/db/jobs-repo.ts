import type { JobStateView } from "../../shared/types";
import type { Db } from "./database";

export const JOB_NIGHTLY = "nightly_handoff";
/** 早间任务（现在只刷新 tracker 状态）；名字是 jobs 表里已有的行，不改。 */
export const JOB_MORNING = "morning_brief";
/** Butler 总控的每日巡检（BTL-190 第 5 点）：lastRunAt 是巡检消息送到（或者放弃）的时刻。 */
export const JOB_PATROL = "butler_patrol";
export type JobName = typeof JOB_NIGHTLY | typeof JOB_MORNING | typeof JOB_PATROL;

export type JobState = JobStateView;

export class JobsRepo {
  constructor(private readonly db: Db) {}

  get(name: JobName): JobState {
    const r = this.db.prepare(`SELECT last_run_at, last_status, last_error FROM jobs WHERE name = ?`).get(name) as
      | { last_run_at: number | null; last_status: string | null; last_error: string | null }
      | undefined;
    return { lastRunAt: r?.last_run_at ?? null, lastStatus: r?.last_status ?? null, lastError: r?.last_error ?? null };
  }

  record(name: JobName, at: number, status: string, error: string | null): void {
    this.db
      .prepare(
        `INSERT INTO jobs (name, last_run_at, last_status, last_error) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = excluded.last_status, last_error = excluded.last_error`,
      )
      .run(name, at, status, error);
  }
}
