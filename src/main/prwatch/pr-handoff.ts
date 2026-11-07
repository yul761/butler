import type { Pr } from "../../shared/handoff";
import type { WatchedPr } from "../../shared/types";

/** 同一个 PR：按链接认（去掉末尾斜杠、不分大小写）。 */
const prKey = (url: string): string => url.trim().replace(/\/+$/, "").toLowerCase();

const sameSet = (a: Pr[], b: Pr[]): boolean => {
  const sig = (prs: Pr[]) => prs.map((p) => `${prKey(p.url)}|${p.number}|${p.state}|${p.review}`).sort().join("\n");
  return sig(a) === sig(b);
};

/**
 * 纯函数：PrWatcher 看到 PR 的状态或 review 变了之后，这个 ticket 下一条 refresh handoff 的 prs 和 sourceRef。
 * rows 是这个 ticket 在 pr_watch 里的行；有 PR 的那些换成 prs（state 已经是小写）。上一条 handoff（base）里、
 * 这些行没有的 PR（不在 ticket 仓库里的、还没查到的）原样留着。
 * sourceRef 是 `prwatch:<ticket>:<number:state:review,…>@<base 的 id>`：同一次变化重复调用会被当成重复丢掉；
 * 带上 base 是因为 review 可能来回变（approved → pending → approved），只看状态的话第二次 approved 会被当成重复。
 * 没有 PR 的行、或者 prs 和 base 一样（没什么可写的）时返回 null。
 */
export function prHandoff(ticketKey: string, rows: WatchedPr[], base: { id: number; prs: Pr[] }): { prs: Pr[]; sourceRef: string } | null {
  const watched: Pr[] = [];
  for (const r of rows) {
    if (r.number === null || r.url === null || r.state === null) continue;
    watched.push({ number: r.number, url: r.url, state: r.state, review: r.review });
  }
  if (watched.length === 0) return null;
  const seen = new Set(watched.map((p) => prKey(p.url)));
  const prs = [...watched, ...base.prs.filter((p) => !seen.has(prKey(p.url)))];
  if (sameSet(prs, base.prs)) return null;
  const signature = watched.map((p) => `${p.number}:${p.state}:${p.review ?? ""}`).join(",");
  return { prs, sourceRef: `prwatch:${ticketKey}:${signature}@${base.id}` };
}
