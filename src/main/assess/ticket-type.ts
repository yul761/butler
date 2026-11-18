import type { ResolvedPrPolicy } from "../../shared/pr-policy";

/**
 * ticket 类型（设计 §5 R10）：Butler 的 ticket 没有类型字段，按 PR 的 label、再按分支前缀推断。都对不上返回 null。
 * label 不区分大小写；分支前缀按最长的先比。
 */
export function inferTicketType(labels: readonly string[], branch: string | null, types: ResolvedPrPolicy["risk"]["types"]): string | null {
  for (const l of labels) {
    const t = types.labels[l.trim().toLowerCase()];
    if (t) return t;
  }
  if (branch) {
    const b = branch.toLowerCase();
    const prefixes = Object.keys(types.branchPrefixes).sort((x, y) => y.length - x.length);
    for (const p of prefixes) if (b.startsWith(p)) return types.branchPrefixes[p]!;
  }
  return null;
}
