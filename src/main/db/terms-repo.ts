import type { SensitiveTerm, TermCategory } from "../../shared/llm";
import { withTransaction, type Db } from "./database";

/** 规范化：NFKC（全角字母数字归一）后去掉首尾空白。空串表示无效。 */
export function normalizeTerm(raw: string): string {
  return raw.normalize("NFKC").trim();
}

export class TermsRepo {
  constructor(private readonly db: Db) {}

  list(): SensitiveTerm[] {
    const rows = this.db.prepare(`SELECT term, category FROM sensitive_terms ORDER BY category, term`).all() as unknown as { term: string; category: string }[];
    return rows.map((r) => ({ term: r.term, category: r.category as TermCategory }));
  }

  /**
   * 整表替换（设置页一次保存全部）。仓库层自己规范化：NFKC + trim，丢弃空串，
   * 按规范化后的值不分大小写去重（保留第一个）。
   */
  replaceAll(terms: readonly SensitiveTerm[]): void {
    const seen = new Set<string>();
    const kept: SensitiveTerm[] = [];
    for (const t of terms) {
      const term = normalizeTerm(t.term);
      if (term === "") continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push({ term, category: t.category });
    }
    withTransaction(this.db, () => {
      this.db.exec(`DELETE FROM sensitive_terms`);
      const ins = this.db.prepare(`INSERT OR IGNORE INTO sensitive_terms (term, category) VALUES (?, ?)`);
      for (const t of kept) ins.run(t.term, t.category);
    });
  }
}
