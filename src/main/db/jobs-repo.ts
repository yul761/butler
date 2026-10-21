import type { Db } from "./database";

export const JOB_NIGHTLY = "nightly_handoff";
export const JOB_EVENING = "evening_brief";
export const JOB_MORNING = "morning_brief";
export type JobName = typeof JOB_NIGHTLY | typeof JOB_EVENING | typeof JOB_MORNING;

export interface JobState {
  lastRunAt: number | null;
  /** ok | partial | failed | seeded */
  lastStatus: string | null;
  lastError: string | null;
}

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
