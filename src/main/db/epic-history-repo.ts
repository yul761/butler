import type { Db } from "./database";

export type EpicHistoryTrigger = "weekly" | "feature_archived";

/** epic 的长期记忆（计划 16 任务 6）：每次整理追加一条，不覆盖旧的。不属于 epic 的 feature 归档时 epicId 为 null。 */
export interface EpicHistoryEntry {
  id: number;
  epicId: number | null;
  featureId: number | null;
  trigger: EpicHistoryTrigger;
  createdAt: number;
  coversFrom: number;
  coversUntil: number;
  payload: { summary: string; decisions: Array<{ what: string; why: string }> };
}

interface EpicHistoryRow {
  id: number;
  epic_id: number | null;
  feature_id: number | null;
  trigger: string;
  created_at: number;
  covers_from: number;
  covers_until: number;
  payload: string;
}

/** 读不出来的 payload（不该出现：只有 Butler 自己写）当作空的，不让一行坏数据挡住整份历史。 */
function parsePayload(text: string): EpicHistoryEntry["payload"] {
  try {
    const v = JSON.parse(text) as Partial<EpicHistoryEntry["payload"]>;
    const decisions = Array.isArray(v.decisions)
      ? v.decisions.filter((d): d is { what: string; why: string } => typeof d?.what === "string" && typeof d?.why === "string")
      : [];
    return { summary: typeof v.summary === "string" ? v.summary : "", decisions };
  } catch {
    return { summary: "", decisions: [] };
  }
}

const toEntry = (r: EpicHistoryRow): EpicHistoryEntry => ({
  id: Number(r.id),
  epicId: r.epic_id === null ? null : Number(r.epic_id),
  featureId: r.feature_id === null ? null : Number(r.feature_id),
  trigger: r.trigger as EpicHistoryTrigger,
  createdAt: r.created_at,
  coversFrom: r.covers_from,
  coversUntil: r.covers_until,
  payload: parsePayload(r.payload),
});

/** epic_history：只追加。epicId 传 null 查的是不属于 epic 的 feature 的记录（SQL 里用 IS 比较）。 */
export class EpicHistoryRepo {
  constructor(private readonly db: Db) {}

  add(e: Omit<EpicHistoryEntry, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO epic_history (epic_id, feature_id, trigger, created_at, covers_from, covers_until, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.epicId, e.featureId, e.trigger, e.createdAt, e.coversFrom, e.coversUntil, JSON.stringify(e.payload));
    return Number(r.lastInsertRowid);
  }

  /** 最新的在前。 */
  list(epicId: number | null, limit: number): EpicHistoryEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM epic_history WHERE epic_id IS ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(epicId, limit) as unknown as EpicHistoryRow[];
    return rows.map(toEntry);
  }

  /** 这个 epic 已经整理到的时刻；还没有记录为 null。 */
  lastCoveredUntil(epicId: number | null): number | null {
    const r = this.db.prepare(`SELECT MAX(covers_until) AS at FROM epic_history WHERE epic_id IS ?`).get(epicId) as { at: number | null } | undefined;
    return r?.at ?? null;
  }

  /** 这个 epic 最近一次每周整理的时间；没有为 null。每周整理据此不在同一周里跑两次。 */
  lastWeeklyAt(epicId: number | null): number | null {
    const r = this.db.prepare(`SELECT MAX(created_at) AS at FROM epic_history WHERE epic_id IS ? AND trigger = 'weekly'`).get(epicId) as
      | { at: number | null }
      | undefined;
    return r?.at ?? null;
  }
}
