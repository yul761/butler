import type { ReviewRequestedPr } from "../tickets/gh";
import { prUrlKey } from "../../shared/pr-url";
import { withTransaction, type Db } from "./database";

/** 别人请你 review 的 PR（UI 重做第 1 层）：每次 gh search 的结果整体替换，first_seen_at 用来显示「请你多久了」。 */
export interface ReviewRequestRow extends ReviewRequestedPr { firstSeenAt: number; lastSeenAt: number }

interface Row { url_key: string; url: string; slug: string; number: number; title: string; author: string; first_seen_at: number; last_seen_at: number }

const toRow = (r: Row): ReviewRequestRow => ({
  url: r.url, slug: r.slug, number: Number(r.number), title: r.title, author: r.author, firstSeenAt: Number(r.first_seen_at), lastSeenAt: Number(r.last_seen_at),
});

export class ReviewRequestsRepo {
  constructor(private readonly db: Db) {}

  /** 一次查询的结果整体替换：还在的保留 first_seen_at、更新标题 / 作者 / last_seen_at；不在的删掉；新的 first_seen_at = now。一个事务。 */
  replaceAll(list: ReviewRequestedPr[], now: number): void {
    withTransaction(this.db, () => {
      const keys = new Set<string>();
      const up = this.db.prepare(
        `INSERT INTO review_requests (url_key, url, slug, number, title, author, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url_key) DO UPDATE SET url = excluded.url, slug = excluded.slug, number = excluded.number, title = excluded.title,
           author = excluded.author, last_seen_at = excluded.last_seen_at`,
      );
      for (const p of list) {
        const key = prUrlKey(p.url);
        if (keys.has(key)) continue;
        keys.add(key);
        up.run(key, p.url, p.slug, p.number, p.title, p.author, now, now);
      }
      const del = this.db.prepare(`DELETE FROM review_requests WHERE url_key = ?`);
      for (const r of this.db.prepare(`SELECT url_key FROM review_requests`).all() as unknown as { url_key: string }[]) {
        if (!keys.has(r.url_key)) del.run(r.url_key);
      }
    });
  }

  /** 按 first_seen_at 从早到晚。 */
  list(): ReviewRequestRow[] {
    return (this.db.prepare(`SELECT * FROM review_requests ORDER BY first_seen_at, url_key`).all() as unknown as Row[]).map(toRow);
  }
}
