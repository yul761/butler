import type { SensitiveTerm, TermCategory } from "../../shared/llm";
import { withTransaction, type Db } from "./database";

export class TermsRepo {
  constructor(private readonly db: Db) {}

  list(): SensitiveTerm[] {
    const rows = this.db.prepare(`SELECT term, category FROM sensitive_terms ORDER BY category, term`).all() as unknown as { term: string; category: string }[];
    return rows.map((r) => ({ term: r.term, category: r.category as TermCategory }));
  }

  /** 整表替换（设置页一次保存全部）。调用方先用 normalizeTerms 规范化；只差大小写的重复项保留第一个。 */
  replaceAll(terms: readonly SensitiveTerm[]): void {
    withTransaction(this.db, () => {
      this.db.exec(`DELETE FROM sensitive_terms`);
      const ins = this.db.prepare(`INSERT OR IGNORE INTO sensitive_terms (term, category) VALUES (?, ?)`);
      for (const t of terms) ins.run(t.term, t.category);
    });
  }
}
