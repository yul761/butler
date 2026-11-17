// PR 进度：把 ticket 的每个 PR 推导成一行（六步进度条和时间线），仓库还没有 PR 时一行“没有 PR”。
import type { PrStageRepo } from "../db/pr-stage-repo";
import { prGivenUp, type TicketPr } from "../db/ticket-prs-repo";
import type { PrStagesScope, PrStagesTicket, PrStagesView } from "../../shared/pr-stages";
import { effectiveStatus, type Ticket } from "../../shared/types";
import { assignToPrs, prEnd, type ScopePr } from "./pr-scope";
import { derivePrStages, type DeriveInput } from "./pr-stages";

export interface PrStagesServiceDeps {
  /** byFeature 含已归档的 ticket。 */
  tickets: { get(key: string): Ticket | null; byFeature(featureId: number): Ticket[] };
  features: {
    /** 含已归档的 feature。 */
    byEpic(epicId: number): { id: number; epicId: number | null }[];
    get(id: number): { id: number; epicId: number | null } | null;
  };
  stages: Pick<PrStageRepo, "forTicket" | "upperDesign">;
  /** 这个 ticket 链接的 PR。 */
  prs: { byTicket(ticketKey: string): TicketPr[] };
  /** 这个 ticket 的 report：at、text、发 report 的 session 的仓库和 git 分支。 */
  reports(ticketKey: string): { at: number; text: string; repoId: number | null; branch: string | null }[];
  /** hook 从什么时候起记 skill 调用；null = 看不到。 */
  skillTrackingSince(): number | null;
}

/** 路径最后一段（兼容结尾的斜杠）。 */
const baseName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

const scopePr = (p: TicketPr): ScopePr => ({
  id: p.id, repoId: p.repoId, slug: p.slug, number: p.number, headBranch: p.headBranch, start: p.openedAt ?? p.linkedAt, end: prEnd(p),
});

/**
 * D-6：ticket 的 PR 都合并或关闭、至少一个合并；或者（手动优先的）状态已经是 merged_pending_followup / done。
 * 一直读不到、放弃了的（prGivenUp）开着的 PR 不挡。
 */
export function ticketMerged(
  t: Pick<Ticket, "status" | "statusManual">, prs: (Pick<TicketPr, "state"> & Partial<Pick<TicketPr, "readRetryAt">>)[],
): boolean {
  const status = effectiveStatus(t);
  if (status === "merged_pending_followup" || status === "done") return true;
  return prs.length > 0 && prs.every((p) => p.state !== "open" || prGivenUp({ readRetryAt: p.readRetryAt ?? null })) && prs.some((p) => p.state === "merged");
}

export class PrStagesService {
  constructor(private readonly d: PrStagesServiceDeps) {}

  /** 范围内每个 ticket（含已归档的）一项，ticket 顺序。 */
  view(scope: PrStagesScope): PrStagesTicket[] {
    const since = this.d.skillTrackingSince();
    return this.ticketsOf(scope).map((t) => this.ticketOf(t, since));
  }

  private ticketsOf(scope: PrStagesScope): Ticket[] {
    if ("ticketKey" in scope) {
      const t = this.d.tickets.get(scope.ticketKey);
      return t ? [t] : [];
    }
    if ("featureId" in scope) return this.d.tickets.byFeature(scope.featureId);
    return this.d.features.byEpic(scope.epicId).flatMap((f) => this.d.tickets.byFeature(f.id));
  }

  private ticketOf(t: Ticket, since: number | null): PrStagesTicket {
    const upper = t.featureId === null ? [] : this.d.stages.upperDesign(t.featureId, this.d.features.get(t.featureId)?.epicId ?? null);
    const repos = [...t.repos].sort((a, b) => a.id - b.id);
    const prs = [...this.d.prs.byTicket(t.key)].sort((a, b) => (b.openedAt ?? b.linkedAt) - (a.openedAt ?? a.linkedAt) || b.id - a.id);
    const scopes = prs.map(scopePr);
    const refs = repos.map((r) => ({ id: r.id, branch: r.branch }));
    // pr_opened / merged / closed 的 PR 号在 data.number 里。
    const events = assignToPrs(
      this.d.stages.forTicket(t.key).map((e) => ({ ...e, number: typeof e.data.number === "number" ? e.data.number : null })),
      scopes, refs,
    );
    const reports = assignToPrs(
      this.d.reports(t.key).map((r) => ({ ...r, prId: null, number: null })),
      scopes, refs,
    );
    const texts = (rs: { at: number; text: string }[] | undefined) => (rs ?? []).map(({ at, text }) => ({ at, text }));
    const row = (o: Pick<DeriveInput, "repoId" | "repoName" | "branch" | "events" | "reports" | "pr">, extra: Pick<PrStagesView, "prId" | "slug" | "noPr">): PrStagesView => ({
      ...derivePrStages({ ticketKey: t.key, featureId: t.featureId, ticketCreatedAt: t.createdAt, upperDesign: upper, skillTrackingSince: since, ...o }),
      ...extra,
    });

    // 没有 PR 的仓库一行；有 PR 的仓库只在最后一个 PR 结束后又有提交时才有这一行。
    const noPrRows = repos
      .filter((r) => !prs.some((p) => p.repoId === r.id) || (events.noPr.get(r.id) ?? []).some((e) => e.kind === "first_commit"))
      .map((r) => row(
        { repoId: r.id, repoName: baseName(r.repoPath), branch: r.branch, events: events.noPr.get(r.id) ?? [], reports: texts(reports.noPr.get(r.id)), pr: null },
        { prId: null, slug: null, noPr: true },
      ));
    const prRows = prs.map((p) => {
      const r = repos.find((x) => x.id === p.repoId);
      return row(
        {
          repoId: r ? r.id : null, repoName: r ? baseName(r.repoPath) : p.slug, branch: p.headBranch,
          events: events.byPr.get(p.id) ?? [], reports: texts(reports.byPr.get(p.id)),
          pr: { number: p.number, url: p.url, state: p.state, ci: p.ci, review: p.review, mergedAt: p.mergedAt, closedAt: p.closedAt, checkedAt: p.checkedAt },
        },
        { prId: p.id, slug: r ? null : p.slug, noPr: false },
      );
    });
    return {
      ticketKey: t.key, title: t.title, featureId: t.featureId, archived: t.archivedAt !== null, merged: ticketMerged(t, prs),
      hasRepos: t.repos.length > 0, rows: [...noPrRows, ...prRows],
    };
  }
}
