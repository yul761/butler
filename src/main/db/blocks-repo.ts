import type { Block } from "../../shared/types";
import { withTransaction, type Db } from "./database";

/**
 * epic 里的 feature（BTL-246 层级 A′）。内部叫 block：界面上的 epic 是 features 表，
 * 界面上的 feature 是这张 blocks 表（见 docs/superpowers/specs/2026-11-20-btl-246-epic-hierarchy-design.md §2）。
 */
interface BlockRow {
  id: number;
  feature_id: number;
  name: string;
  description: string | null;
  position: number;
  created_at: number;
}

const toBlock = (r: BlockRow): Block => ({
  id: Number(r.id),
  featureId: Number(r.feature_id),
  name: r.name,
  description: r.description,
  position: Number(r.position),
  createdAt: r.created_at,
});

/** 按 key 分组，保持行的顺序。 */
function groupBy<K, T>(rows: readonly T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export class BlocksRepo {
  constructor(private readonly db: Db) {}

  /** 按顺序。 */
  list(featureId: number): Block[] {
    const rows = this.db.prepare(`SELECT * FROM blocks WHERE feature_id = ? ORDER BY position, id`).all(featureId) as unknown as BlockRow[];
    return rows.map(toBlock);
  }

  /** 几个 epic 的 feature 一次读（BTL-275：首页每次刷新对每个 epic 各查一次）。每个 epic 内的顺序同 list()；没有的不在 Map 里。 */
  listMany(featureIds: readonly number[]): Map<number, Block[]> {
    if (featureIds.length === 0) return new Map();
    const rows = this.db
      .prepare(`SELECT * FROM blocks WHERE feature_id IN (SELECT value FROM json_each(?)) ORDER BY feature_id, position, id`)
      .all(JSON.stringify(featureIds)) as unknown as BlockRow[];
    return groupBy(rows.map(toBlock), (b) => b.featureId);
  }

  get(id: number): Block | null {
    const row = this.db.prepare(`SELECT * FROM blocks WHERE id = ?`).get(id) as BlockRow | undefined;
    return row ? toBlock(row) : null;
  }

  /** 名字在一个 epic 里唯一，比较时不分大小写、去掉两头空白。 */
  byName(featureId: number, name: string): Block | null {
    const n = name.trim().toLowerCase();
    return this.list(featureId).find((b) => b.name.trim().toLowerCase() === n) ?? null;
  }

  /** 新 feature 放在最后，给了 before 就放在它前面（后面的顺次后移）。返回 id。 */
  insert(b: { featureId: number; name: string; description: string | null; createdAt: number; before?: number | null }): number {
    return withTransaction(this.db, () => {
      const list = this.list(b.featureId);
      const at = b.before == null ? -1 : list.findIndex((x) => x.id === b.before);
      const position = at < 0 ? list.length : at;
      const res = this.db
        .prepare(`INSERT INTO blocks (feature_id, name, description, position, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(b.featureId, b.name, b.description, list.length + 1000, b.createdAt);
      const id = Number(res.lastInsertRowid);
      const order = list.map((x) => x.id);
      order.splice(position, 0, id);
      this.writeOrder(order);
      return id;
    });
  }

  /** order：这个 epic 的全部 feature 的 id，每个正好一次（调用方检查）。 */
  reorder(order: number[]): void {
    withTransaction(this.db, () => this.writeOrder(order));
  }

  private writeOrder(order: number[]): void {
    const st = this.db.prepare(`UPDATE blocks SET position = ? WHERE id = ?`);
    order.forEach((id, i) => st.run(i, id));
  }
}
