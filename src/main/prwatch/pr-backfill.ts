import type { Pr } from "../../shared/handoff";
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
  const repoOf = new Map<number, { t: Ticket; r: TicketRepo }>();
  let linked = 0;
  let failed = 0;
  let consecutive = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) return;
      const item = queue.shift();
      if (!item) return;
      const { t, r } = item;
      const list = await d.prsForBranch(d.ghWorkDir(r), r.branch, PR_GH_TIMEOUT_MS).catch((e: unknown) => {
        d.log(`pr backfill: gh threw for ${t.key} ${r.repoPath}`, e);
        return null;
      });
      if (list === null) {
        failed++;
        consecutive++;
        d.log(`pr backfill: gh failed for ${t.key} ${r.repoPath} (${r.branch})`);
        continue;
      }
      consecutive = 0;
      branchPrs.set(r.id, list);
      repoOf.set(r.id, { t, r });
    }
  };
  await Promise.all(Array.from({ length: GH_PARALLEL }, worker));

  // 先链接 handoff 和占位里的（它们的 state 可能是旧的），最后链接 GitHub 列出来的：没读过的行会采用最后写的 state，GitHub 的为准。
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
  for (const [repoId, list] of branchPrs) {
    const { t, r } = repoOf.get(repoId)!;
    const created = d.linker.linkBranchPrs(t.key, r, list, "backfill");
    linked += created;
    if (created > 0) d.soon?.(repoId);
  }

  const ok = failed === 0;
  d.jobs.record(JOB_PR_BACKFILL, d.now(), ok ? "ok" : "failed", ok ? null : `${failed} gh call(s) failed`);
  return { ok, linked, failed };
}
