import type { Handoff } from "../../shared/handoff";
import { NOTE_BODY_LIMIT, noteBody, noteId, parseNote, sameBody, type ButlerNote, type MemoryItem } from "../../shared/memory";
import type { Followup, FollowupKind, FollowupTrigger, HandoffRecord } from "../../shared/types";

/** 一个 ticket scope 里 Butler 自己最多维护多少条：StateCore 每个 scope 的 notes 上限是 30（超出淘汰最旧的），给 Claude 自己的 remember 留 6 条。 */
export const BUTLER_NOTE_LIMIT = 24;

const KIND_LABEL: Record<FollowupKind, string> = { config: "配置", flag: "开关", deploy: "部署", doc: "文档", other: "其他" };
const TRIGGER_LABEL: Record<FollowupTrigger, string> = { after_merge: "合并后", after_deploy: "部署后", on_date: "到期日", none: "无触发条件" };

export function followupNote(f: Followup): ButlerNote {
  const due = f.trigger === "on_date" && f.dueDate ? ` ${f.dueDate}` : "";
  // 说明后缀不过 noteBody（NFKC 会把全角括号和逗号变成半角），所以先给它留出长度，再截断描述。
  const label = noteBody(`${KIND_LABEL[f.kind]}，${TRIGGER_LABEL[f.trigger]}${due}`).replace(",", "，");
  const suffix = `（${label}）`;
  const desc = Array.from(noteBody(f.description)).slice(0, Math.max(0, NOTE_BODY_LIMIT - Array.from(suffix).length)).join("").trim();
  return { kind: "followup", id: noteId(f.id), body: desc ? `${desc}${suffix}` : "" };
}

export function decisionNote(key: string, statement: string): ButlerNote {
  return { kind: "decision", id: noteId(key), body: noteBody(statement) };
}

export type FullHandoff = HandoffRecord & { payload: Handoff };
export const isFull = (h: HandoffRecord): h is FullHandoff => h.payload !== null && h.trigger !== "refresh";

/**
 * 这个 ticket 在 StateCore 里应该有的 Butler 条目（设计文档 8.3）：
 * - 未完成（open / snoozed）的 followup，按创建时间；
 * - 决策：所有有效的完整 handoff（不含早间刷新）里每个 key 最新的那句话，按最近一次变化从新到旧。
 * followup 在前；正文为空的跳过；总数不超过 BUTLER_NOTE_LIMIT。handoffs 的顺序不限。
 */
export function desiredNotes(handoffs: HandoffRecord[], followups: Followup[]): ButlerNote[] {
  const decisions = new Map<string, { note: ButlerNote; at: number }>();
  const full = handoffs.filter(isFull).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  for (const h of full) {
    for (const d of h.payload.decisions) {
      const note = decisionNote(d.key, d.statement);
      if (!note.body) continue;
      const prev = decisions.get(note.id);
      // 同一句话在后面的 handoff 里重复出现，不算“变化”：保留它第一次出现的时间。
      if (prev && sameBody(prev.note.body, note.body)) continue;
      decisions.set(note.id, { note, at: h.createdAt });
    }
  }
  const seen = new Set<string>();
  const open = followups
    .filter((f) => f.status === "open" || f.status === "snoozed")
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(followupNote)
    .filter((n) => n.body && !seen.has(n.id) && seen.add(n.id));
  const decided = [...decisions.values()].sort((a, b) => b.at - a.at).map((d) => d.note);
  return [...open, ...decided].slice(0, BUTLER_NOTE_LIMIT);
}

export interface ReconcilePlan {
  /** 要 forget 的 factKey。 */
  forget: string[];
  /** 要写的条目（写的时候先试不带变体的前缀）；write.length 就是这次想新增的条数。 */
  write: ButlerNote[];
}

/**
 * 现状（StateCore facts()）和期望之间的差异。只看 Butler 前缀的条目，Claude 自己写的和蒸馏出来的一律不动。
 * 同一个条目：正文相同（宽松比较，任何变体后缀）的留一条，其余的 forget；正文变了就 forget 全部旧的、写新的。
 * 期望里已经没有的条目全部 forget。
 */
export function planReconcile(current: MemoryItem[], desired: ButlerNote[]): ReconcilePlan {
  const byKey = new Map<string, { factKey: string; body: string }[]>();
  for (const it of current) {
    const p = parseNote(it.text);
    if (!p) continue;
    const key = `${p.kind}:${p.id}`;
    byKey.set(key, [...(byKey.get(key) ?? []), { factKey: it.factKey, body: p.body }]);
  }
  const plan: ReconcilePlan = { forget: [], write: [] };
  const wanted = new Set<string>();
  for (const n of desired) {
    const key = `${n.kind}:${n.id}`;
    if (wanted.has(key)) continue;
    wanted.add(key);
    const have = byKey.get(key) ?? [];
    const keep = have.find((h) => sameBody(h.body, n.body));
    for (const h of have) if (h !== keep) plan.forget.push(h.factKey);
    if (!keep) plan.write.push(n);
  }
  for (const [key, have] of byKey) if (!wanted.has(key)) for (const h of have) plan.forget.push(h.factKey);
  return plan;
}
