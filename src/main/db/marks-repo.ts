import type { ItemMark, MarkState } from "../../shared/brief";
import type { Db } from "./database";

/** 简报里非 followup 条目的“完成 / 推迟 / 忽略”。 */
export class MarksRepo {
  constructor(private readonly db: Db) {}

  set(itemKey: string, mark: ItemMark, untilDate: string | null, at: number): void {
    this.db
      .prepare(
        `INSERT INTO item_marks (item_key, mark, until_date, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(item_key) DO UPDATE SET mark = excluded.mark, until_date = excluded.until_date, created_at = excluded.created_at`,
      )
      .run(itemKey, mark, untilDate, at);
  }

  all(): Map<string, MarkState> {
    const rows = this.db.prepare(`SELECT item_key, mark, until_date FROM item_marks`).all() as unknown as {
      item_key: string;
      mark: string;
      until_date: string | null;
    }[];
    return new Map(rows.map((r) => [r.item_key, { mark: r.mark as ItemMark, untilDate: r.until_date }]));
  }
}
