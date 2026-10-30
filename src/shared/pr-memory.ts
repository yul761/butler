import type { Pr } from "./handoff";

/** 同一个 PR：按链接认（去掉末尾斜杠、不分大小写）；没有链接时按 PR 号。 */
function prId(p: Pr): string {
  const url = p.url.trim().replace(/\/+$/, "").toLowerCase();
  return url || `#${p.number}`;
}

/**
 * PR 合并之后不会再变。之后的 handoff（晚间、早间刷新、worktree 清理之后）常常不再提它，或者把它报成别的状态，
 * 结果 ticket 显示“还没有 PR”。这里把以前记下的“已合并”补回来：
 * - latest 里有、以前合并过的：按已合并算；
 * - latest 里没有、以前合并过的：接在后面（新的在前）；
 * - 以前开着、关掉的 PR 不补：它们会变，只信最新一次。
 * older 从新到旧。
 */
export function rememberMergedPrs(latest: Pr[], older: Pr[][]): Pr[] {
  const merged = new Map<string, Pr>();
  for (const prs of older) for (const p of prs) if (p.state === "merged" && !merged.has(prId(p))) merged.set(prId(p), p);
  const out = latest.map((p) => (p.state !== "merged" && merged.has(prId(p)) ? { ...p, state: "merged" as const } : p));
  const seen = new Set(out.map(prId));
  for (const [id, p] of merged) if (!seen.has(id)) out.push(p);
  return out;
}
