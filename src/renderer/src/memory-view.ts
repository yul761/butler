import { parseNote, type MemoryItem, type WhyEntry } from "../../shared/memory";
import { S } from "./strings";

export interface MemoryRow {
  item: MemoryItem;
  /** 显示的文字：Butler 的条目去掉前缀。 */
  text: string;
}

export interface MemorySection {
  title: string;
  rows: MemoryRow[];
}

/** 记忆标签的分区：决策、未完成的 follow-up（Butler 写的），然后按 StateCore 的分组列出其余的。空的分区不显示。 */
export function memorySections(items: MemoryItem[]): MemorySection[] {
  const decisions: MemoryRow[] = [];
  const followups: MemoryRow[] = [];
  const others = new Map<string, MemoryRow[]>();
  for (const item of items) {
    const p = parseNote(item.text);
    if (p?.kind === "decision") decisions.push({ item, text: p.body });
    else if (p?.kind === "followup") followups.push({ item, text: p.body });
    else {
      const title = item.group === "Notes" ? S.memoryNotes : item.group;
      others.set(title, [...(others.get(title) ?? []), { item, text: item.text }]);
    }
  }
  return [
    { title: S.memoryDecisions, rows: decisions },
    { title: S.memoryFollowups, rows: followups },
    ...[...others].map(([title, rows]) => ({ title, rows })),
  ].filter((s) => s.rows.length > 0);
}

export type WhyState = "current" | "replaced" | "retired";

export interface WhyLine {
  text: string;
  when: string;
  state: WhyState;
  note: string | null;
}

/** why 链的每个版本（旧的在前）：正文（去掉 Butler 前缀）、时间、状态。 */
export function whyLines(chain: WhyEntry[], formatTime: (iso: string) => string): WhyLine[] {
  return chain.map((e) => ({
    text: parseNote(e.content)?.body ?? e.content,
    when: formatTime(e.addedAt),
    state: e.retiredAt ? "retired" : e.supersededBy ? "replaced" : "current",
    note: e.retiredReason ? S.whyRetiredReason(e.retiredReason) : null,
  }));
}

/**
 * 记忆事件（memory:changed）是不是和这个 ticket 的记忆标签有关：changed 是同步过的 ticket，null 表示记忆开关变了（所有 ticket）。
 */
export function memoryChangeConcerns(changed: string | null, ticketKey: string): boolean {
  return changed === null || changed === ticketKey;
}

/**
 * 尾部防抖：连续触发只在最后一次之后 ms 毫秒执行一次。启动和打开记忆时会连着同步很多 ticket，
 * 每次重读都会打开 StateCore，所以记忆标签用它合并。cancel() 在卸载时调用。
 */
export function trailingDebounce(fn: () => void, ms: number): { (): void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
  run.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return run;
}
