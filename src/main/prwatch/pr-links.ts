import type { Pr } from "../../shared/handoff";
import { prUrlParts } from "../../shared/pr-url";
import type { MergeHold } from "../db/merge-gate-repo";
import { rewriteSlugUrl } from "../db/repo-renames-repo";
import type { PrLinkSource, TicketPrsRepo } from "../db/ticket-prs-repo";
import type { BranchPr } from "../tickets/gh";
import type { TicketsRepo } from "../db/tickets-repo";

export const PR_STATES = { OPEN: "open", MERGED: "merged", CLOSED: "closed" } as const;

export interface PrLinkerDeps {
  prs: TicketPrsRepo;
  tickets: Pick<TicketsRepo, "get">;
  slugOf(path: string): string | null;
  /** 记过的仓库改名：旧 slug 给现在的名字，别的原样（BTL-261）。不给就不换。 */
  canonical?(slug: string): string;
  /**
   * 链接的仓库名和 origin 的不一样（仓库可能改了名）：交给改名处理去确认。gh 按 origin 列出来的 PR 换了仓库名时调；
   * handoff 里的 PR 对不上 ticket 的任何仓库时，对 ticket 的每个 origin 也调一次（改名还没记下时，新链接要靠它发现）。
   */
  onSlugMoved?(oldSlug: string, newSlug: string): void;
  log?(msg: string): void;
  now(): number;
}

interface Parsed {
  url: string;
  slug: string;
  number: number;
}

/** 把 handoff 里报的 PR 和合并总控占着的 PR 链接到 ticket_prs（新行下一轮就会被读）。没有链接的 PR 不在这里链接。 */
export class PrLinker {
  constructor(private readonly d: PrLinkerDeps) {}

  private canon(slug: string): string {
    return this.d.canonical ? this.d.canonical(slug) : slug;
  }

  /** 解析 PR 链接；仓库改过名的换成新名字（链接和 slug 一起换），免得同一个 PR 在新旧两个链接下各记一行。 */
  private parse(url: string): Parsed | null {
    const parts = prUrlParts(url);
    if (!parts) return null;
    const slug = this.canon(parts.slug);
    return { url: slug === parts.slug ? url : rewriteSlugUrl(url, parts.slug, slug), slug, number: parts.number };
  }

  /** slug 对得上的 ticket 仓库（都按改名后的名字比）；不是这个 ticket 的仓库返回 null。 */
  repoFor(ticketKey: string, slug: string): number | null {
    const repos = this.d.tickets.get(ticketKey)?.repos ?? [];
    const want = this.canon(slug);
    return repos.find((r) => {
      const s = this.d.slugOf(r.repoPath);
      return s !== null && this.canon(s) === want;
    })?.id ?? null;
  }

  /** ticket 各仓库 origin 的 slug（改名后的名字，去重）。 */
  private originSlugs(ticketKey: string): string[] {
    const out = new Set<string>();
    for (const r of this.d.tickets.get(ticketKey)?.repos ?? []) {
      const s = this.d.slugOf(r.repoPath);
      if (s !== null) out.add(this.canon(s));
    }
    return [...out];
  }

  /**
   * 返回新建了几行。handoff 里的链接是 session 自己写的，可能写错（BTL-190 写成了 yuchenlin/butler）：
   * 只收 ticket 某个仓库 remote 上的 PR，别的仓库的不收录（读不到，只会一直重试）。
   */
  linkHandoffPrs(ticketKey: string, prs: Pr[]): number {
    let created = 0;
    for (const p of prs) {
      const parts = this.parse(p.url);
      if (!parts) continue;
      const repoId = this.repoFor(ticketKey, parts.slug);
      if (repoId === null) {
        this.d.log?.(`pr links: ${ticketKey}'s handoff names ${parts.url}, which is not in any of the ticket's repos; not tracking it`);
        for (const s of this.originSlugs(ticketKey)) if (s !== parts.slug) this.d.onSlugMoved?.(s, parts.slug);
        continue;
      }
      const r = this.d.prs.link({
        ticketKey, url: parts.url, slug: parts.slug, repoId, number: parts.number,
        headBranch: null, state: p.state, source: "handoff", linkedAt: this.d.now(),
      });
      if (r.created) created++;
    }
    return created;
  }

  /**
   * 一个分支上 gh 列出来的 PR 链接到 ticket 仓库（watcher 和一次性补链接共用）：GitHub 的状态和时间原样带上；
   * URL 解析不出 slug 时用仓库自己的 slug。返回新建了几行。
   */
  linkBranchPrs(ticketKey: string, repo: { id: number; repoPath: string; branch: string }, list: BranchPr[], source: PrLinkSource): number {
    const origin = this.d.slugOf(repo.repoPath);
    const repoSlug = origin === null ? null : this.canon(origin);
    let created = 0;
    for (const b of list) {
      const parsed = this.parse(b.url);
      if (parsed && repoSlug && parsed.slug !== repoSlug) this.d.onSlugMoved?.(repoSlug, parsed.slug);
      const slug = parsed?.slug ?? repoSlug;
      if (!slug) continue;
      const r = this.d.prs.link({
        ticketKey, url: parsed?.url ?? b.url, slug, repoId: repo.id, number: b.number, headBranch: b.headRefName || repo.branch, state: PR_STATES[b.state],
        openedAt: b.createdAt, mergedAt: b.mergedAt, closedAt: b.closedAt, source, linkedAt: this.d.now(),
      });
      if (r.created) created++;
    }
    return created;
  }

  /**
   * session 刚用 gh pr create 开的 PR（工作流 W）：按打出来的链接马上链接上，分支是开 PR 的那个。
   * 链接必须是 repoId 这个仓库的（同一条命令里 gh pr list、git log 打出来的别的 PR 不算）。返回是不是新建了一行。
   */
  linkCreatedPr(ticketKey: string, url: string, headBranch: string, repoId: number): boolean {
    const parts = this.parse(url);
    if (!parts || this.repoFor(ticketKey, parts.slug) !== repoId) return false;
    return this.d.prs.link({
      ticketKey, url: parts.url, slug: parts.slug, repoId, number: parts.number,
      headBranch, state: PR_STATES.OPEN, source: "branch", linkedAt: this.d.now(),
    }).created;
  }

  /** 占位的 PR 链接到它的 ticket（ticket_key 为空时用 session 的 ticket）。返回是不是新建了一行。 */
  linkHold(h: MergeHold, sessionTicket: (sessionId: string) => string | null): boolean {
    const parts = h.prUrl ? this.parse(h.prUrl) : null;
    const ticketKey = h.ticketKey ?? (h.sessionId ? sessionTicket(h.sessionId) : null);
    if (!h.prUrl || !parts || !ticketKey) return false;
    return this.d.prs.link({
      ticketKey, url: parts.url, slug: parts.slug, repoId: this.repoFor(ticketKey, parts.slug), number: parts.number,
      headBranch: h.branch, state: h.outcome === "merged" ? "merged" : "open",
      mergedAt: h.outcome === "merged" ? h.releasedAt : null, source: "merge_gate", linkedAt: this.d.now(),
    }).created;
  }
}
