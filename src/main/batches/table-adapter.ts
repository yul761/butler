import type { Db } from "../db/database";
import type { EntityAdapter, Snapshot } from "./batch-recorder";

/** 跟着主行一起拍快照、一起恢复的子表（如规矩的出处、产品的仓库）。 */
export interface ChildTable {
  table: string;
  /** 指向主行 id 的列。 */
  fk: string;
  orderBy: string;
  /** 插回去失败时（引用的行没了）改成 NULL 再试的列。 */
  nullable?: readonly string[];
}

export interface TableAdapterSpec {
  entity: string;
  table: string;
  volatile?: readonly string[];
  /** 不进快照的列（撤销不改回它，比较时也不看）：由别的实体单独记（规矩的 principle_id）。 */
  detached?: readonly string[];
  children?: readonly ChildTable[];
  stampColumn?: string;
  /** 外键指向这张表的行（撤销时删不删这一行看它们）。 */
  dependents?: readonly { table: string; fk: string }[];
  describe(s: Snapshot): { label: string; state: string };
}

type Val = string | number | null;
const toVal = (v: unknown): Val => (v === null || v === undefined ? null : typeof v === "number" || typeof v === "string" ? v : typeof v === "bigint" ? Number(v) : JSON.stringify(v));

/**
 * 按表拍快照的通用适配器：快照 = 整行 + 子表的行。列名只认表结构里有的（快照存在库里，读回来也不信任它的键）。
 */
export function tableAdapter(db: Db, spec: TableAdapterSpec): EntityAdapter {
  const colsCache = new Map<string, Set<string>>();
  const cols = (table: string): Set<string> => {
    let c = colsCache.get(table);
    if (!c) {
      c = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
      colsCache.set(table, c);
    }
    return c;
  };
  const detached = new Set(spec.detached ?? []);
  const known = (table: string, row: Record<string, unknown>): [string, Val][] =>
    Object.entries(row).filter(([k]) => cols(table).has(k) && !(table === spec.table && detached.has(k))).map(([k, v]) => [k, toVal(v)]);

  const insert = (table: string, entries: [string, Val][]): void => {
    db.prepare(`INSERT INTO ${table} (${entries.map(([k]) => k).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`).run(...entries.map(([, v]) => v));
  };

  const insertChild = (child: ChildTable, row: Record<string, unknown>, parentId: number): void => {
    const entries = known(child.table, { ...row, [child.fk]: parentId });
    try {
      insert(child.table, entries);
    } catch {
      // 原 id 被占了，或引用的行没了：不带 id、把可空的引用置空再插一次。
      const nulls = new Set(child.nullable ?? []);
      insert(child.table, entries.filter(([k]) => k !== "id").map(([k, v]) => [k, nulls.has(k) ? null : v]));
    }
  };

  return {
    entity: spec.entity,
    // 以前存下的快照可能还带着 detached 的列：比较时一起去掉。
    volatile: [...(spec.volatile ?? []), ...detached],
    snapshot(id) {
      const row = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      const s: Snapshot = { ...row };
      for (const k of detached) delete s[k];
      for (const c of spec.children ?? []) {
        s[`$${c.table}`] = db.prepare(`SELECT * FROM ${c.table} WHERE ${c.fk} = ? ORDER BY ${c.orderBy}`).all(id) as Record<string, unknown>[];
      }
      return s;
    },
    restore(id, to) {
      if (to === null) {
        db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(id);
        return;
      }
      const entries = known(spec.table, to).filter(([k]) => k !== "id");
      const exists = db.prepare(`SELECT 1 FROM ${spec.table} WHERE id = ?`).get(id) !== undefined;
      if (exists) {
        if (entries.length) db.prepare(`UPDATE ${spec.table} SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...entries.map(([, v]) => v), id);
      } else {
        insert(spec.table, [["id", id], ...entries]);
      }
      for (const c of spec.children ?? []) {
        const rows = Array.isArray(to[`$${c.table}`]) ? (to[`$${c.table}`] as Record<string, unknown>[]) : [];
        db.prepare(`DELETE FROM ${c.table} WHERE ${c.fk} = ?`).run(id);
        for (const r of rows) if (r && typeof r === "object") insertChild(c, r, id);
      }
    },
    stamp: spec.stampColumn
      ? (id, batchId) => {
          db.prepare(`UPDATE ${spec.table} SET ${spec.stampColumn} = ? WHERE id = ?`).run(batchId, id);
        }
      : undefined,
    dependents: spec.dependents?.length
      ? (id) => spec.dependents!.reduce((n, d) => n + Number((db.prepare(`SELECT COUNT(*) AS n FROM ${d.table} WHERE ${d.fk} = ?`).get(id) as { n: number }).n), 0)
      : undefined,
    describe: spec.describe,
  };
}

/** 规矩：整行 + 出处；batch_id 记最近一次改动它的批次。 */
export const lessonAdapter = (db: Db): EntityAdapter =>
  tableAdapter(db, {
    entity: "lesson",
    table: "lessons",
    volatile: ["updated_at"],
    // 归到哪条原则由 lesson_principle 单独记：每天的重新分组不挡别的批次撤销，撤销别的批次也不动分组。
    detached: ["principle_id"],
    children: [{ table: "lesson_sources", fk: "lesson_id", orderBy: "id", nullable: ["run_id"] }],
    stampColumn: "batch_id",
    dependents: [{ table: "lessons", fk: "merged_into" }],
    describe: (s) => ({ label: String(s.text ?? ""), state: s.merged_into !== null && s.merged_into !== undefined ? "merged" : String(s.status ?? "") }),
  });

/** 产品：名字 + 包含的仓库。 */
export const productAdapter = (db: Db): EntityAdapter =>
  tableAdapter(db, {
    entity: "product",
    table: "lesson_products",
    children: [{ table: "lesson_product_repos", fk: "product_id", orderBy: "repo_slug" }],
    dependents: [{ table: "lessons", fk: "product_id" }, { table: "admission_policies", fk: "product_id" }, { table: "checks", fk: "product_id" }],
    describe: (s) => ({ label: String(s.name ?? ""), state: Array.isArray(s.$lesson_product_repos) ? `${s.$lesson_product_repos.length} repos` : "" }),
  });

/** 准入策略的一层。 */
export const policyAdapter = (db: Db): EntityAdapter =>
  tableAdapter(db, {
    entity: "policy",
    table: "admission_policies",
    volatile: ["updated_at"],
    describe: (s) => ({
      label: s.scope_kind === "global" ? "global" : s.scope_kind === "product" ? `product #${String(s.product_id)}` : `repo ${String(s.repo_slug)}`,
      state: String(s.overrides ?? "{}"),
    }),
  });

/** 原则（工作流 D）：重新分组是一个能撤销的批次。 */
export const principleAdapter = (db: Db): EntityAdapter =>
  tableAdapter(db, {
    entity: "principle",
    table: "lesson_principles",
    volatile: ["updated_at"],
    stampColumn: "batch_id",
    dependents: [{ table: "lessons", fk: "principle_id" }],
    describe: (s) => ({ label: String(s.text ?? ""), state: s.scope_kind === "product" ? `product #${String(s.product_id)}` : `repo ${String(s.repo_slug)}` }),
  });

/** 规矩归到的原则（只有 principle_id 一列）：原则重新分组的批次里记这个，不记整条规矩。 */
export const lessonPrincipleAdapter = (db: Db): EntityAdapter => ({
  entity: "lesson_principle",
  snapshot(id) {
    const r = db.prepare(`SELECT principle_id FROM lessons WHERE id = ?`).get(id) as { principle_id: number | null } | undefined;
    return r ? { principle_id: r.principle_id === null ? null : Number(r.principle_id) } : null;
  },
  restore(id, to) {
    if (to === null) return; // 规矩本身不归这个实体管
    const v = to.principle_id;
    db.prepare(`UPDATE lessons SET principle_id = ? WHERE id = ?`).run(typeof v === "number" ? v : null, id);
  },
  describe: (s) => ({ label: s.principle_id === null || s.principle_id === undefined ? "—" : `principle #${String(s.principle_id)}`, state: "" }),
});

/** 确定性检查的一行（契约 4.5）；batch_id 记最近一次改动它的批次。 */
export const checkAdapter = (db: Db): EntityAdapter =>
  tableAdapter(db, {
    entity: "check",
    table: "checks",
    volatile: ["updated_at"],
    stampColumn: "batch_id",
    describe: (s) => ({
      label: String(s.name || s.type || ""),
      state: `${String(s.mode ?? "")}/${String(s.severity ?? "")}${s.enabled === 0 ? " off" : ""}`,
    }),
  });

/** 标记文件表的覆盖行（工作流 E2）：导入能撤销。 */
export const baselineRuleAdapter = (db: Db): EntityAdapter =>
  tableAdapter(db, {
    entity: "baseline_rule",
    table: "baseline_rules",
    volatile: ["updated_at"],
    describe: (s) => ({ label: String(s.key ?? ""), state: s.enabled === 0 ? "off" : "on" }),
  });

/** 导入的仓库现状（工作流 E2）：撤销就删掉这一条。 */
export const baselineAdapter = (db: Db): EntityAdapter =>
  tableAdapter(db, {
    entity: "baseline",
    table: "repo_baselines",
    describe: (s) => ({ label: String(s.repo_slug ?? ""), state: String(s.origin ?? "") }),
  });
