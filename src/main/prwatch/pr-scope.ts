// PR 进度：把 ticket 的事件和 report 分到它链接的各个 PR 上；合并之后的不再算到那个 PR（C-V6、D-11）。
import type { TicketPr } from "../db/ticket-prs-repo";

/** 能分到 PR 的一条：事件或 report。 */
export interface Scoped {
  at: number;
  repoId: number | null;
  branch: string | null;
  prId: number | null;
  number: number | null;
}

export interface ScopePr {
  id: number;
  repoId: number | null;
  slug: string;
  number: number;
  headBranch: string | null;
  /** openedAt ?? linkedAt。 */
  start: number;
  /** prEnd(pr)。 */
  end: number;
}

/** PR 结束的时间：开着的是 Infinity；否则合并时间、关闭时间，都没有就用最后一次读取的时间。 */
export function prEnd(pr: Pick<TicketPr, "state" | "mergedAt" | "closedAt" | "checkedAt">): number {
  return pr.state === "open" ? Infinity : pr.mergedAt ?? pr.closedAt ?? pr.checkedAt;
}

/**
 * 分组：ticket 仓库按 repoId，不是 ticket 仓库的 PR 按 slug。一条依次看：
 * prId 对得上 → 那个 PR；有 number → 所在组里号码相同的 PR；
 * 否则在自己的组（repoId 为 null 时每个组）里，同分支的 PR（没有就全部）中取 end >= at 最小的，一样时 start 最晚的；
 * 都已经结束 → ticket 仓库的组放进 noPr，slug 的组丢掉。
 */
export function assignToPrs<T extends Scoped>(
  items: T[],
  prs: ScopePr[],
  repos: { id: number; branch: string }[],
): { byPr: Map<number, T[]>; noPr: Map<number, T[]> } {
  const repoIds = new Set(repos.map((r) => r.id));
  const groups = new Map<number | string, ScopePr[]>(repos.map((r) => [r.id, []]));
  for (const p of prs) {
    const key = p.repoId !== null && repoIds.has(p.repoId) ? p.repoId : `slug:${p.slug}`;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const byPr = new Map<number, T[]>();
  const noPr = new Map<number, T[]>();
  const push = <K>(m: Map<K, T[]>, k: K, it: T) => {
    const bucket = m.get(k);
    if (bucket) bucket.push(it);
    else m.set(k, [it]);
  };

  for (const it of items) {
    const own = it.prId === null ? undefined : prs.find((p) => p.id === it.prId);
    if (own) {
      push(byPr, own.id, it);
      continue;
    }
    const keys = it.repoId === null ? [...groups.keys()] : groups.has(it.repoId) ? [it.repoId] : [];
    const numbered = it.number === null ? [] : keys.flatMap((k) => groups.get(k)!.filter((p) => p.number === it.number));
    if (numbered.length > 0) {
      for (const p of numbered) push(byPr, p.id, it);
      continue;
    }
    for (const k of keys) {
      const all = groups.get(k)!;
      const onBranch = it.branch === null ? [] : all.filter((p) => p.headBranch === it.branch);
      const best = (onBranch.length > 0 ? onBranch : all)
        .filter((p) => p.end >= it.at)
        .reduce<ScopePr | null>((b, p) => (b === null || p.end < b.end || (p.end === b.end && p.start > b.start) ? p : b), null);
      if (best) push(byPr, best.id, it);
      else if (typeof k === "number") push(noPr, k, it);
    }
  }
  return { byPr, noPr };
}
