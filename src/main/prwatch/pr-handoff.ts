import type { Handoff, Pr } from "../../shared/handoff";
import { dedupeHandoffPrs } from "../../shared/pr-memory";
import { prUrlKey } from "../../shared/pr-url";
import type { TicketPr } from "../db/ticket-prs-repo";

/** 同一个 PR：按链接认（去掉末尾斜杠、不分大小写）。 */
const sameSet = (a: Pr[], b: Pr[]): boolean => {
  const sig = (prs: Pr[]) => prs.map((p) => `${prUrlKey(p.url)}|${p.number}|${p.state}|${p.review}`).sort().join("\n");
  return sig(a) === sig(b);
};

/**
 * 纯函数：PrWatcher 看到 PR 的状态或 review 变了之后，这个 ticket 下一条 refresh handoff 的 prs、status 和 sourceRef。
 * rows 是这个 ticket 在 ticket_prs 里的行（所有分支、所有仓库，包括不是 ticket 仓库的）；读过的那些换成 prs。
 * 还没读过的行（checked_at 为 0）状态只是链接时的猜测，不写。上一条 handoff（base）里、这些行没有的 PR 原样留着。
 * status 现在沿用 base 的。
 * sourceRef 是 `prwatch:<ticket>:<number:state:review,…>@<base 的 id>`：同一次变化重复调用会被当成重复丢掉；
 * 带上 base 是因为 review 可能来回变（approved → pending → approved），只看状态的话第二次 approved 会被当成重复。
 * 没有读过的行、或者 prs 和 base 一样（没什么可写的）时返回 null。
 */
export function prHandoff(
  ticketKey: string, rows: TicketPr[], base: { id: number; createdAt: number; status: Handoff["status"]; prs: Pr[] },
): { prs: Pr[]; status: Handoff["status"]; sourceRef: string } | null {
  const watched: Pr[] = rows.filter((r) => r.checkedAt > 0).map((r) => ({ number: r.number, url: r.url, state: r.state, review: r.review }));
  if (watched.length === 0) return null;
  const seen = new Set(watched.map((p) => prUrlKey(p.url)));
  const prs = dedupeHandoffPrs([...watched, ...base.prs.filter((p) => !seen.has(prUrlKey(p.url)))]);
  if (sameSet(prs, base.prs)) return null;
  const signature = watched.map((p) => `${p.number}:${p.state}:${p.review ?? ""}`).join(",");
  return { prs, status: base.status, sourceRef: `prwatch:${ticketKey}:${signature}@${base.id}` };
}
