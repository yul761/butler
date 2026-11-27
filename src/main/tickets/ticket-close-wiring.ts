import type { TicketCloseSource } from "../../shared/types";
import { endSessionRefusal } from "../control/end-guard";
import { prGivenUp, type TicketPr } from "../db/ticket-prs-repo";
import type { AttemptResult, ExternalDetail } from "../external/actions";
import { M } from "../strings";
import type { PrHead } from "./gh";
import { classifyOpenPrs, type LiveSession, type OpenPrs, type TicketCloseDeps, type UnclosablePr } from "./ticket-close";

/** 关 PR 前核对 head 用的超时。 */
export const CLOSE_VERIFY_TIMEOUT_MS = 10_000;
/** 不管默认分支叫什么都当作公共分支的名字。 */
const ALWAYS_PUBLIC = ["main", "master"];

/**
 * 关 ticket 的对外接线（BTL-270 审查，建议 3）：哪些开着的 PR 能关、怎么关、怎么结束 session。从 index.ts 拿出来，好单独测。
 * 只依赖这里列的这些，index.ts 把真的仓库、gh、pty、对外动作开关接进来。
 */
export interface CloseWiringDeps {
  tickets: {
    get(key: string): { repos: { id: number; branch: string }[] } | null;
    getRepo(id: number): { repoPath: string } | null;
  };
  ticketPrs: { byTicket(key: string): TicketPr[]; byUrl(url: string): Pick<TicketPr, "ticketKey">[] };
  branchOwners: { get(ticketKey: string, repoId: number, branch: string): unknown };
  ghDir(pr: { repoId: number | null }): string;
  /** 仓库的默认分支（origin/HEAD）。 */
  defaultBranch(repoPath: string): Promise<string>;
  /** gh pr view 核对 head；读不到是 null。 */
  prHead(cwd: string, url: string, timeoutMs: number): Promise<PrHead | null>;
  prClose(cwd: string, slug: string | null, n: number, comment: string): Promise<void>;
  external: {
    attempt<T>(kind: "pr_open", detail: ExternalDetail, run: () => Promise<T>): Promise<AttemptResult<T>>;
    record(kind: "pr_open", detail: ExternalDetail & { outcome: "done" | "failed"; error?: string | null }): number;
  };
  sessions: {
    /** activityMonitor 看到的状态（idle、waiting、working…）。 */
    activityKind(id: string): string | null;
    waitingForInput(id: string): boolean;
    screenNeedsUser(termId: string): boolean;
    setUserEnded(id: string, at: number): void;
    kill(termId: string): void;
    /** 休眠着的不再唤醒，等用户回答的标记也清掉。 */
    forgetHibernated(id: string): void;
  };
  now(): number;
  log(msg: string, e?: unknown): void;
}

export function closeWiring(d: CloseWiringDeps): Pick<TicketCloseDeps, "openPrs" | "closePr" | "endSession"> {
  return {
    // 读过、没放弃、在 ticket 自己仓库里、head 分支是这个 ticket 自己的分支的开着的 PR 能关（在那个仓库的 gh 目录里跑）；
    // 其余看着开着的照样报出来、写明原因，不当作关完了（classifyOpenPrs）。
    openPrs: async (key) => {
      const t = d.tickets.get(key);
      const rows = d.ticketPrs.byTicket(key);
      // 公共分支（BTL-270 审查）：仓库的默认分支和 main / master。从那里开的 PR 不是哪个 ticket 自己的，就算 ticket 记的分支也叫这个。
      const publicByRepo = new Map<number, Set<string>>();
      for (const repoId of new Set(rows.filter((r) => r.state === "open" && r.repoId !== null).map((r) => r.repoId!))) {
        const repo = d.tickets.getRepo(repoId);
        const names = new Set(ALWAYS_PUBLIC);
        if (repo) {
          try {
            names.add(await d.defaultBranch(repo.repoPath));
          } catch (e) {
            d.log(`ticket ${key}: reading the default branch of ${repo.repoPath} failed`, e);
          }
        }
        publicByRepo.set(repoId, names);
      }
      const first = classifyOpenPrs<TicketPr>(rows, {
        givenUp: (p) => prGivenUp(p),
        // ticket 仓库的分支，和 session 推过、记了归属的分支（worktree 里的子 session）。
        ownBranch: (repoId, branch) => (t?.repos.some((r) => r.id === repoId && r.branch === branch) ?? false) || d.branchOwners.get(key, repoId, branch) !== null,
        publicBranch: (repoId, branch) => publicByRepo.get(repoId)?.has(branch) ?? false,
        // 同一个 PR 也挂在别的 ticket 上（关了的也算：重新打开它时 PR 还要在）：不替那个 ticket 关。
        sharedWith: (p) => d.ticketPrs.byUrl(p.url).map((r) => r.ticketKey).find((k) => k !== key) ?? null,
        ghDir: (p) => d.ghDir(p),
      });
      return verifyHeads(d, first);
    },
    // 用户在关闭框里勾了要关的：照做，审计里记一笔（和 stacks 关草稿 PR 同一类）。总控、路由发起的和别的对外动作一样看开关。
    closePr: async (pr, reason, o) => {
      const detail = { scope: { repoSlug: pr.slug, ticketKey: o.key }, target: pr.url, summary: `close #${pr.number} (ticket closed)`, payload: reason };
      const run = () => d.prClose(pr.cwd, pr.slug, pr.number, M().ticketClosePrComment(reason));
      if (o.source !== "user") return (await d.external.attempt("pr_open", detail, run)).ran ? "closed" : "skipped";
      try {
        await run();
        d.external.record("pr_open", { ...detail, outcome: "done" });
        return "closed";
      } catch (e) {
        d.external.record("pr_open", { ...detail, outcome: "failed", error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
    // 关终端并记成用户结束的（不会被自动恢复）；休眠着的不再唤醒。用户自己勾的和点 × 一样；
    // 总控、路由发起的和 end_session 一样：正在干活、屏幕上有等用户回答的确认，不关。
    endSession: (s: LiveSession, source: TicketCloseSource) => {
      if (s.termId && source !== "user") {
        const termId = s.termId;
        const refusal = endSessionRefusal(s.id, {
          kind: d.sessions.activityKind(s.id), waitingForInput: d.sessions.waitingForInput(s.id), screenNeedsUser: () => d.sessions.screenNeedsUser(termId),
        });
        if (refusal) return { ok: false, error: refusal };
      }
      d.sessions.setUserEnded(s.id, d.now());
      if (s.termId) d.sessions.kill(s.termId);
      else if (s.hibernated) d.sessions.forgetHibernated(s.id);
      return { ok: true };
    },
  };
}

/**
 * 能关的再用 gh 核对一次 head（BTL-270 审查）：fork 上的同名分支（isCrossRepository）不是 ticket 自己的，不关；
 * 已经不开着的不列。读不到的当作还没读到（不去关一个没核对过的 PR）。
 */
async function verifyHeads(d: CloseWiringDeps, open: OpenPrs): Promise<OpenPrs> {
  const closable: OpenPrs["closable"] = [];
  const unclosable: UnclosablePr[] = [...open.unclosable];
  for (const pr of open.closable) {
    const head = await d.prHead(pr.cwd, pr.url, CLOSE_VERIFY_TIMEOUT_MS).catch((e: unknown) => {
      d.log(`checking the head of ${pr.url} failed`, e);
      return null;
    });
    if (head === null) unclosable.push({ url: pr.url, number: pr.number, kind: "never_read" });
    else if (head.crossRepo) unclosable.push({ url: pr.url, number: pr.number, kind: "not_own_branch" });
    else if (!head.open) continue;
    else closable.push(pr);
  }
  return { closable, unclosable };
}
