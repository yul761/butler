// PR 进度：把 ticket 的每个仓库推导成一行（六步进度条和时间线）。
import type { PrStageRepo } from "../db/pr-stage-repo";
import type { PrWatchRow } from "../db/pr-watch-repo";
import type { PrStagesScope, PrStagesView } from "../../shared/pr-stages";
import type { Ticket } from "../../shared/types";
import { derivePrStages } from "./pr-stages";

export interface PrStagesServiceDeps {
  tickets: { get(key: string): Ticket | null; byFeature(featureId: number): Ticket[] };
  features: {
    byEpic(epicId: number): { id: number; epicId: number | null }[];
    get(id: number): { id: number; epicId: number | null } | null;
  };
  stages: Pick<PrStageRepo, "forRepo" | "upperDesign">;
  prWatch: { get(repoId: number): PrWatchRow | null };
  /** 这个 ticket 的 report：at、text、发 report 的 session 的 repoId。 */
  reports(ticketKey: string): { at: number; text: string; repoId: number | null }[];
  /** hook 程序是当前版本，能看到 skill 调用；否则设计和自我 review 显示“未知”。 */
  skillTracking(): boolean;
}

/** 路径最后一段（兼容结尾的斜杠）。 */
const baseName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export class PrStagesService {
  constructor(private readonly d: PrStagesServiceDeps) {}

  /** 范围内每个 ticket 的每个仓库一行：ticket 顺序，再按仓库 id。 */
  view(scope: PrStagesScope): PrStagesView[] {
    const skillTracking = this.d.skillTracking();
    return this.ticketsOf(scope).flatMap((t) => this.rowsOf(t, skillTracking));
  }

  private ticketsOf(scope: PrStagesScope): Ticket[] {
    if ("ticketKey" in scope) {
      const t = this.d.tickets.get(scope.ticketKey);
      return t ? [t] : [];
    }
    if ("featureId" in scope) return this.d.tickets.byFeature(scope.featureId);
    return this.d.features.byEpic(scope.epicId).flatMap((f) => this.d.tickets.byFeature(f.id));
  }

  private rowsOf(t: Ticket, skillTracking: boolean): PrStagesView[] {
    const upper = t.featureId === null ? [] : this.d.stages.upperDesign(t.featureId, this.d.features.get(t.featureId)?.epicId ?? null);
    const reports = this.d.reports(t.key);
    return [...t.repos]
      .sort((a, b) => a.id - b.id)
      .map((r) => {
        // ticket 的分支改过时 pr_watch 里还是旧分支的行：当作没有（和 PrWatcher.rowOf 一样）。
        const row = this.d.prWatch.get(r.id);
        const pr = row && row.branch === r.branch ? row : null;
        return derivePrStages({
          ticketKey: t.key, featureId: t.featureId, repoId: r.id, repoName: baseName(r.repoPath), branch: r.branch,
          ticketCreatedAt: t.createdAt,
          events: this.d.stages.forRepo(t.key, r.id, r.branch),
          upperDesign: upper,
          reports: reports.filter((x) => x.repoId === null || x.repoId === r.id).map(({ at, text }) => ({ at, text })),
          pr: pr ? { number: pr.number, url: pr.url, state: pr.state } : null,
          skillTracking,
        });
      });
  }
}
