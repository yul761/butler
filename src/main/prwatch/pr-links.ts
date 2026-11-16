import type { Pr } from "../../shared/handoff";
import { prUrlParts } from "../../shared/pr-url";
import type { MergeHold } from "../db/merge-gate-repo";
import type { TicketPrsRepo } from "../db/ticket-prs-repo";
import type { TicketsRepo } from "../db/tickets-repo";

export interface PrLinkerDeps {
  prs: TicketPrsRepo;
  tickets: Pick<TicketsRepo, "get">;
  slugOf(path: string): string | null;
  now(): number;
}

/** 把 handoff 里报的 PR 和合并总控占着的 PR 链接到 ticket_prs（新行下一轮就会被读）。没有链接的 PR 不在这里链接。 */
export class PrLinker {
  constructor(private readonly d: PrLinkerDeps) {}

  /** slug 对得上的 ticket 仓库；不是这个 ticket 的仓库返回 null。 */
  repoFor(ticketKey: string, slug: string): number | null {
    const repos = this.d.tickets.get(ticketKey)?.repos ?? [];
    return repos.find((r) => this.d.slugOf(r.repoPath) === slug)?.id ?? null;
  }

  /** 返回新建了几行。 */
  linkHandoffPrs(ticketKey: string, prs: Pr[]): number {
    let created = 0;
    for (const p of prs) {
      const parts = prUrlParts(p.url);
      if (!parts) continue;
      const r = this.d.prs.link({
        ticketKey, url: p.url, slug: parts.slug, repoId: this.repoFor(ticketKey, parts.slug), number: parts.number,
        headBranch: null, state: p.state, source: "handoff", linkedAt: this.d.now(),
      });
      if (r.created) created++;
    }
    return created;
  }

  /** 占位的 PR 链接到它的 ticket（ticket_key 为空时用 session 的 ticket）。返回是不是新建了一行。 */
  linkHold(h: MergeHold, sessionTicket: (sessionId: string) => string | null): boolean {
    const parts = h.prUrl ? prUrlParts(h.prUrl) : null;
    const ticketKey = h.ticketKey ?? (h.sessionId ? sessionTicket(h.sessionId) : null);
    if (!h.prUrl || !parts || !ticketKey) return false;
    return this.d.prs.link({
      ticketKey, url: h.prUrl, slug: parts.slug, repoId: this.repoFor(ticketKey, parts.slug), number: parts.number,
      headBranch: h.branch, state: h.outcome === "merged" ? "merged" : "open",
      mergedAt: h.outcome === "merged" ? h.releasedAt : null, source: "merge_gate", linkedAt: this.d.now(),
    }).created;
  }
}
