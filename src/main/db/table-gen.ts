// 表的「原地改写代数」（BTL-265）：只追加的表按（行数、最大 id）就能认出变没变，
// 但有少数地方会原地改已有的行（仓库改名改写 JSON 里的链接）。那些地方改完调 bumpTableGen，按表缓存的读者把它也算进戳里。
// 按 Db 分开记：测试里每个内存库互不影响。
import type { Db } from "./database";

const gens = new WeakMap<Db, Map<string, number>>();

export function tableGen(db: Db, table: string): number {
  return gens.get(db)?.get(table) ?? 0;
}

/** 这张表有行被原地改了（不是追加）：按（行数、最大 id）缓存的结果要重算。 */
export function bumpTableGen(db: Db, table: string): void {
  let m = gens.get(db);
  if (!m) gens.set(db, (m = new Map()));
  m.set(table, (m.get(table) ?? 0) + 1);
}
