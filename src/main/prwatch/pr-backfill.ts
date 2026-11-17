import type { Pr } from "../../shared/handoff";
import { prUrlParts } from "../../shared/pr-url";
import type { Ticket, TicketRepo } from "../../shared/types";
import { JOB_PR_BACKFILL, type JobsRepo } from "../db/jobs-repo";
import type { MergeHold } from "../db/merge-gate-repo";
import type { TicketPrsRepo } from "../db/ticket-prs-repo";
import type { BranchPr, prsForBranch } from "../tickets/gh";
import type { PrLinker } from "./pr-links";
import { PR_GH_TIMEOUT_MS } from "./pr-watcher";

export interface PrBackfillDeps {
  /** 包括归档的 ticket。 */
  tickets(): Ticket[];
  linker: PrLinker;
  prs: TicketPrsRepo;
  handoffPrs(ticketKey: string): Pr[];
  holds(): MergeHold[];
  sessionTicket(sessionId: string): string | null;
  prsForBranch: typeof prsForBranch;
  ghWorkDir(r: TicketRepo): string;
  jobs: Pick<JobsRepo, "get" | "record">;
  now(): number;
  log(msg: string, e?: unknown): void;
  /** 这个仓库新链接了 PR：让 watcher 马上去读。 */
  soon?(repoId: number): void;
}

const GH_PARALLEL = 2;
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * 一次性补链接：每个 ticket 仓库分支上的所有 PR，加上 handoff 里报过的和合并总控占过的。
 * 这里不读 PR：新行 checked_at = 0，由 PrWatcher 去读并按真实时间写事件；merged_handled_at 也不在这里设，
 * 合不合并后复盘由 watcher 的 MERGED_RECENT_MS 判断。每次写都是 upsert，失败后下次启动重跑是安全的。
 */
export async function runPrBackfill(d: PrBackfillDeps): Promise<{ ok: boolean; linked: number; failed: number }> {
  if (d.jobs.get(JOB_PR_BACKFILL).lastStatus === "ok") return { ok: true, linked: 0, failed: 0 };
  const tickets = d.tickets();
  const queue = tickets.flatMap((t) => t.repos.map((r) => ({ t, r })));
  const branchPrs = new Map<number, BranchPr[]>();
  let linked = 0;
  let failed = 0;
  let consecutive = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) return;
      const item = queue.shift();
      if (!item) return;
      const { t, r } = item;
      const list = await d.prsForBranch(d.ghWorkDir(r), r.branch, PR_GH_TIMEOUT_MS).catch(() => null);
      if (list === null) {
        failed++;
        consecutive++;
        d.log(`pr backfill: gh failed for ${t.key} ${r.repoPath} (${r.branch})`);
        continue;
      }
      consecutive = 0;
      branchPrs.set(r.id, list);
      let created = 0;
      for (const p of list) {
        const parts = prUrlParts(p.url);
        if (!parts) continue;
        const res = d.prs.link({
          ticketKey: t.key, url: p.url, slug: parts.slug, repoId: r.id, number: p.number, headBranch: p.headRefName || r.branch,
          state: p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : "open",
          openedAt: p.createdAt, mergedAt: p.mergedAt, closedAt: p.closedAt, source: "backfill", linkedAt: d.now(),
        });
        if (res.created) created++;
      }
      linked += created;
      if (created > 0) d.soon?.(r.id);
    }
  };
  await Promise.all(Array.from({ length: GH_PARALLEL }, worker));

  for (const t of tickets) {
    const fromBranch = t.repos.length === 1 ? (branchPrs.get(t.repos[0].id) ?? []) : [];
    const prs = d.handoffPrs(t.key).flatMap((p): Pr[] => {
      if (p.url) return [p];
      const hit = fromBranch.find((b) => b.number === p.number);
      return hit ? [{ ...p, url: hit.url }] : [];
    });
    linked += d.linker.linkHandoffPrs(t.key, prs);
  }
  for (const h of d.holds()) if (d.linker.linkHold(h, d.sessionTicket)) linked++;

  const ok = failed === 0;
  d.jobs.record(JOB_PR_BACKFILL, d.now(), ok ? "ok" : "failed", ok ? null : `${failed} gh call(s) failed`);
  return { ok, linked, failed };
}
