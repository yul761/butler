import type { Db } from "../../db/database";

/** 模型判断的种类（addendum 第 2 节）。 */
export type JudgmentKind = "enrich" | "same" | "canon" | "conflict" | "clarity" | "classify" | "draft" | "sample" | "principle" | "merge" | "merge_fail" | "backtest_fp" | "shadow_fp";

export interface Judgment<T> { result: T; model: string | null; degraded: boolean; at: number }

/**
 * 模型判断的缓存：同一个 kind + key，输入指纹一样就直接用，「重新计算」只重新判、不重新调模型。
 * 输入变了（规矩改了字、范围变了）指纹就不一样，按没有处理。
 */
export class JudgmentCache {
  constructor(private readonly db: Db) {}

  get<T>(kind: JudgmentKind, key: string, hash: string): Judgment<T> | null {
    const r = this.db.prepare(`SELECT input_hash, result, model, degraded, at FROM lesson_judgments WHERE kind = ? AND key = ?`).get(kind, key) as
      | { input_hash: string; result: string; model: string | null; degraded: number; at: number }
      | undefined;
    if (!r || r.input_hash !== hash) return null;
    try {
      return { result: JSON.parse(r.result) as T, model: r.model, degraded: Number(r.degraded) === 1, at: Number(r.at) };
    } catch {
      return null;
    }
  }

  put(kind: JudgmentKind, key: string, hash: string, result: unknown, meta: { model: string | null; degraded: boolean; at: number }): void {
    this.db
      .prepare(
        `INSERT INTO lesson_judgments (kind, key, input_hash, result, model, degraded, at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, key) DO UPDATE SET input_hash = excluded.input_hash, result = excluded.result, model = excluded.model,
           degraded = excluded.degraded, at = excluded.at`,
      )
      .run(kind, key, hash, JSON.stringify(result), meta.model, meta.degraded ? 1 : 0, meta.at);
  }

  /** 一对规矩的键：小的 id 在前。 */
  static pair(a: number, b: number): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }
}
