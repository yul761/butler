import type { HandoffFollowup } from "../../shared/handoff";
import type { Followup, FollowupSource } from "../../shared/types";
import type { FollowupPatch } from "../db/followups-repo";

export interface FollowupMergePlan {
  inserts: Followup[];
  updates: { id: string; patch: FollowupPatch }[];
  done: string[];
}

export interface MergeContext {
  ticketKey: string;
  now: number;
  newId: () => string;
  source: FollowupSource;
}

/** 比较描述时先做 NFKC 规范化（全角括号等同半角），再忽略首尾空白、连续空白和大小写。 */
export const normalizeDescription = (s: string): string => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * 设计文档 5.4 节的合并规则，加上按描述去重：
 * - 按 id 找到已有项；找不到 id（模型忘了或编了一个）就按描述找。
 * - 已忽略、已完成的项保持原样：handoff 不能复活或重新打开它们。
 * - done=true 的置为完成；否则只更新变了的字段（描述只在 id 命中时更新）。
 * - 都没找到的新建（done=true 的新项、空描述、同一次 handoff 里的重复项直接丢弃）。
 * existing 必须是同一个 ticket 的 followups。
 */
export function planFollowupMerge(existing: Followup[], incoming: HandoffFollowup[], ctx: MergeContext): FollowupMergePlan {
  const plan: FollowupMergePlan = { inserts: [], updates: [], done: [] };
  const byId = new Map(existing.map((f) => [f.id, f]));
  const byDesc = new Map<string, Followup>();
  for (const f of existing) {
    const d = normalizeDescription(f.description);
    if (!byDesc.has(d)) byDesc.set(d, f);
  }
  const touched = new Set<string>();
  const newDescs = new Set<string>();
  // 同一次 handoff 里同一项出现多次：只要有一条 done=true，就以完成为准（与顺序无关）。
  const doneDescs = new Set(incoming.filter((f) => f.done).map((f) => normalizeDescription(f.description)));

  for (const f of incoming) {
    const desc = normalizeDescription(f.description);
    if (!desc) continue;
    const dueDate = f.trigger === "on_date" ? f.due_date : null;
    const idHit = f.id !== null ? byId.get(f.id) : undefined;
    const target = idHit ?? byDesc.get(desc);
    if (target) {
      if (touched.has(target.id)) {
        // 先出现的是未完成的更新，后出现的是 done：改成完成。
        if (f.done && (target.status === "open" || target.status === "snoozed") && !plan.done.includes(target.id)) {
          const i = plan.updates.findIndex((u) => u.id === target.id);
          if (i >= 0) plan.updates.splice(i, 1);
          plan.done.push(target.id);
        }
        continue;
      }
      touched.add(target.id);
      if (target.status === "ignored" || target.status === "done") continue;
      if (f.done) {
        plan.done.push(target.id);
        continue;
      }
      const patch: FollowupPatch = {};
      if (f.kind !== target.kind) patch.kind = f.kind;
      if (f.trigger !== target.trigger) patch.trigger = f.trigger;
      if (dueDate !== target.dueDate) patch.dueDate = dueDate;
      if (idHit && f.description.trim() !== target.description) patch.description = f.description.trim();
      if (Object.keys(patch).length > 0) plan.updates.push({ id: target.id, patch });
      continue;
    }
    if (f.done || newDescs.has(desc) || doneDescs.has(desc)) continue;
    newDescs.add(desc);
    plan.inserts.push({
      id: ctx.newId(),
      ticketKey: ctx.ticketKey,
      kind: f.kind,
      description: f.description.trim(),
      trigger: f.trigger,
      dueDate,
      status: "open",
      snoozedUntil: null,
      source: ctx.source,
      createdAt: ctx.now,
      doneAt: null,
    });
  }
  return plan;
}
