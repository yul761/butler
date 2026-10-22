/**
 * StateCore 记忆（设计文档第 8 节）的共享类型。渲染进程也会 import：这里不能 import zod 或 Node 模块。
 */

/** 全局 scope：跨 ticket 的经验（learnings）。 */
export const WORKSPACE_SCOPE = "workspace";

/** 每个 ticket 一个 scope（设计文档 8.2）。 */
export function ticketScope(key: string): string {
  return `ticket:${key}`;
}

/** StateCore facts() 里的一条（只取 Butler 用得到的字段）。 */
export interface MemoryItem {
  /** forget 用的 key（分组名 + 正文的哈希）。 */
  factKey: string;
  /** why 用的 id；StateCore 没有登记的条目为 null。 */
  factId: string | null;
  text: string;
  /** ISO 时间。 */
  createdAt: string | null;
  /** StateCore 的展示分组，例如 Notes。 */
  group: string;
}

/** scope 当前的交接（StateCore 的 handoff）。 */
export interface MemoryHandoff {
  id: string;
  content: string;
  addedAt: string;
  /** 这个 scope 记录过多少次交接（含被取代的）。 */
  versionCount: number;
}

/** why 链上的一个版本，旧的在前。 */
export interface WhyEntry {
  id: string;
  content: string;
  addedAt: string;
  supersededBy: string | null;
  retiredAt: string | null;
  retiredReason: string | null;
}

/** ticket 详情页“记忆”标签的数据。 */
export interface MemoryView {
  /** 设置里的记忆开关。 */
  enabled: boolean;
  scope: string;
  handoff: MemoryHandoff | null;
  items: MemoryItem[];
  /** 读 StateCore 失败时的原因。 */
  error: string | null;
}
