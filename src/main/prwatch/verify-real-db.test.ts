// 手动跑一次的核对（计划 2026-11-16 任务 19）：在真实数据库的副本上迁移、补链接、跑三轮 watcher（真的 gh，只读），看 PR 进度。
// 只在设了 SHIPHERD_VERIFY_DB 时运行，指向 ~/.shipherd/app.db 的副本（连同 -wal / -shm），绝不指向正在用的文件：迁移和补链接都会写库。
// 不发通知、不递 CI、不排复盘、不写 refresh handoff：这些回调都是空的。gh 只用到 pr list / pr view / run list / run view / api 的 GET。
// SHIPHERD_VERIFY_DB=<副本> pnpm vitest run src/main/prwatch/verify-real-db.test.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BranchWatchRepo } from "../db/branch-watch-repo";
import { openDatabase } from "../db/database";
import { HandoffsRepo } from "../db/handoffs-repo";
import { InboxRepo } from "../db/inbox-repo";
import { JobsRepo } from "../db/jobs-repo";
import { MergeGateRepo } from "../db/merge-gate-repo";
import { PrStageRepo } from "../db/pr-stage-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { RepoIdentity } from "../lessons/repo-identity";
import { applyGhResolution, branchRuns, failedLogDetail, prsForBranch, prStatus, reviewAuthors, reviewComments } from "../tickets/gh";
import { firstCommitAt } from "../tickets/git";
import { resolveGh } from "../util/gh-path";
import type { TicketRepo } from "../../shared/types";
import { runPrBackfill } from "./pr-backfill";
import { PrLinker } from "./pr-links";
import { PrStagesService } from "./pr-stages-service";
import { PrWatcher } from "./pr-watcher";
import { skillTrackingSince } from "./skill-tracking";

const file = process.env.SHIPHERD_VERIFY_DB;
const log = (msg: string, e?: unknown) => console.log(`[verify] ${msg}`, e ?? "");
const live = join(homedir(), ".shipherd", "app.db");

/** 正在用的库（连同 -wal / -shm）一律不开：迁移和补链接都会写库。 */
function assertNotLive(path: string): void {
  const p = resolve(path);
  if ([live, `${live}-wal`, `${live}-shm`].includes(p)) throw new Error(`SHIPHERD_VERIFY_DB points at the live database (${p}): use a copy`);
}

describe.skipIf(!file)("real database copy (SHIPHERD_VERIFY_DB)", () => {
  it("backfills feature 1 and BTL-190 into one row per PR", async () => {
    assertNotLive(file!);
    const db = openDatabase(file!);
    try {
      const tickets = new TicketsRepo(db);
      const sessions = new SessionsRepo(db);
      const settings = new SettingsRepo(db);
      const handoffs = new HandoffsRepo(db);
      const gate = new MergeGateRepo(db);
      const inbox = new InboxRepo(db);
      const jobs = new JobsRepo(db);
      const prs = new TicketPrsRepo(db);
      const branches = new BranchWatchRepo(db);
      const stages = new PrStageRepo(db);
      const identity = new RepoIdentity();
      const slugOf = (path: string) => identity.slugOf(path);
      // 同 TicketService.ghWorkDir。
      const ghWorkDir = (r: TicketRepo) => (r.worktreeRemovedAt !== null || r.worktreePath === null ? r.repoPath : r.worktreePath);
      applyGhResolution(resolveGh(process.env.PATH ?? "", process.platform), process.platform, log);
      const linker = new PrLinker({ prs, tickets, slugOf, now: Date.now });

      const backfill = await runPrBackfill({
        tickets: () => tickets.list({ includeArchived: true }),
        linker, prs, jobs,
        handoffPrs: (key) => handoffs.allPrs(key),
        holds: () => gate.prHolds(),
        sessionTicket: (s) => sessions.get(s)?.ticketKey ?? null,
        prsForBranch, ghWorkDir, now: Date.now, log, home: homedir(),
        slugOf: (r) => slugOf(r.repoPath) ?? prs.byTicket(r.ticketKey).find((p) => p.repoId === r.id)?.slug ?? null,
      });
      log(`backfill ${JSON.stringify(backfill)}`);

      const watcher = new PrWatcher({
        prs, branches,
        tickets: () => tickets.list(),
        repoOf: (id) => tickets.getRepo(id),
        ghWorkDir,
        sessionOpen: () => false,
        home: homedir(),
        slugOf, linker,
        gh: { prStatus, prsForBranch, branchRuns, failedLogDetail, reviewComments, reviewAuthors },
        git: { firstCommitAt },
        stages,
        onMerged: () => undefined,
        onPrChanged: () => undefined,
        onCiSettled: () => undefined,
        notify: () => undefined,
        now: Date.now,
        log,
      });
      for (let i = 0; i < 3; i++) await watcher.check();

      const service = new PrStagesService({
        tickets: { get: (key) => tickets.get(key), byFeature: (id) => tickets.listByFeature(id, { includeArchived: true }) },
        stages, prs,
        reports: (key) => inbox.reportsForTicket(key),
        skillTrackingSince: () => skillTrackingSince(settings),
      });
      const feature = service.view({ featureId: 1 });
      const btl190 = service.view({ ticketKey: "BTL-190" });
      log(`feature 1: ${JSON.stringify(feature.map((t) => ({ key: t.ticketKey, merged: t.merged, prs: t.rows.map((r) => r.prNumber) })))}`);
      log(`BTL-190 rows: ${JSON.stringify(btl190[0]?.rows.map((r) => ({ pr: r.prNumber, stages: r.stages.map((c) => `${c.id}:${c.state}`).join(" ") })))}`);
      log(`BTL-190 ticket_prs: ${JSON.stringify(prs.byTicket("BTL-190").map((p) => ({ n: p.number, state: p.state, source: p.source, checked: p.checkedAt > 0, readError: p.readError })))}`);

      expect(feature).toHaveLength(5);
      expect(feature.every((t) => t.merged)).toBe(true);
      expect(btl190[0].rows.map((r) => r.prNumber)).toEqual([29, 28, 27, 26, 25]);
    } finally {
      db.close();
    }
  }, 300_000);
});
