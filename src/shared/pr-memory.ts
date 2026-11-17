import type { Pr } from "./handoff";
import { prUrlKey } from "./pr-url";

/** 同一个 PR：按链接认（去掉末尾斜杠、不分大小写）；没有链接时按 PR 号。 */
function prId(p: Pr): string {
  const url = prUrlKey(p.url);
  return url || `#${p.number}`;
}

/**
 * 同一个 handoff 里同一个 PR 可能一次写成链接、一次写成只有号（url 为空）：有同号且带链接的条目时，空链接的丢掉；
 * 链接相同的留第一个。没有链接又没有同号带链接条目的，按号去重。
 */
export function dedupeHandoffPrs(prs: Pr[]): Pr[] {
  const withUrl = new Set(prs.filter((p) => prUrlKey(p.url) !== "").map((p) => p.number));
  const seen = new Set<string>();
  const out: Pr[] = [];
  for (const p of prs) {
    if (prUrlKey(p.url) === "" && withUrl.has(p.number)) continue;
    const id = prId(p);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}

/**
 * PR 合并之后不会再变。之后的 handoff（晚间、早间刷新、worktree 清理之后）常常不再提它，或者把它报成别的状态，
 * 结果 ticket 显示“还没有 PR”。这里把以前记下的“已合并”补回来：
 * - latest 里有、以前合并过的：按已合并算；
 * - latest 里没有、以前合并过的：接在后面（新的在前）；
 * - 以前开着、关掉的 PR 不补：它们会变，只信最新一次。
 * 同号的 PR，有 URL 的赢过没有 URL 的（空 URL 的条目只是折叠掉）。
 * older 从新到旧。
 */
export function rememberMergedPrs(latest: Pr[], older: Pr[][]): Pr[] {
  const merged = new Map<string, Pr>();
  for (const prs of older) for (const p of dedupeHandoffPrs(prs)) if (p.state === "merged" && !merged.has(prId(p))) merged.set(prId(p), p);
  latest = dedupeHandoffPrs(latest);
  const out = latest.map((p) => (p.state !== "merged" && merged.has(prId(p)) ? { ...p, state: "merged" as const } : p));
  const seen = new Set(out.map(prId));
  for (const [id, p] of merged) if (!seen.has(id)) out.push(p);
  return dedupeHandoffPrs(out);
}

/**
 * 把 rememberMergedPrs 的结果（stored）拆成模型这次自己报的（own，状态已按记忆修正）和全部记着的（remembered）。
 * 按链接认，报的 PR 没有链接时按号认（同 dedupeHandoffPrs）。
 */
export function splitOwnAndRemembered(reported: Pr[], stored: Pr[]): { own: Pr[]; remembered: Pr[] } {
  const ids = new Set(reported.filter((p) => prUrlKey(p.url) !== "").map(prId));
  const numbers = new Set(reported.filter((p) => prUrlKey(p.url) === "").map((p) => p.number));
  return { own: stored.filter((p) => ids.has(prId(p)) || numbers.has(p.number)), remembered: stored };
}
