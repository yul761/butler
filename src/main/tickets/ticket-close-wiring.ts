import type { TicketCloseSource } from "../../shared/types";
import { endSessionRefusal } from "../control/end-guard";
import { prGivenUp, type TicketPr } from "../db/ticket-prs-repo";
import type { AttemptResult, ExternalDetail } from "../external/actions";
import { M } from "../strings";
import { prUrlKey } from "../../shared/pr-url";
import type { PrHead, PrHeadError } from "./gh";
import { classifyOpenPrs, type LiveSession, type OpenPrs, type TicketCloseDeps, type UnclosablePr, type UnclosableKind } from "./ticket-close";

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
    /** 用这个分支名的仓库行（任何 ticket）。 */
    reposOnBranch(branch: string): { ticketKey: string; repoPath: string }[];
  };
  ticketPrs: { byTicket(key: string): TicketPr[]; byUrl(url: string): Pick<TicketPr, "ticketKey">[] };
  branchOwners: {
    get(ticketKey: string, repoId: number, branch: string): unknown;
    /** 推过这个分支名的（任何 ticket、任何仓库）。 */
    byBranch(branch: string): { ticketKey: string; repoId: number }[];
  };
  ghDir(pr: { repoId: number | null }): string;
  /** 仓库路径的 slug（origin，改名后的）；读不到是 null。比较是不是同一个仓库、fork 的 owner 用。 */
  slugOf(repoPath: string): string | null;
  /** 仓库的默认分支（origin/HEAD）。 */
  defaultBranch(repoPath: string): Promise<string>;
  /** gh pr view 实时核对 head；读不到是 { error }（gh 太老时带 ghTooOld）。 */
  prHead(cwd: string, url: string, timeoutMs: number): Promise<PrHead | PrHeadError>;
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
    openPrs: async (key, onlyPrs) => {
      const t = d.tickets.get(key);
      // 点名了的（onlyPrs）只看、只核对这些：不为没点名的 PR 去跑 gh（BTL-270 审查）。
      const rows = d.ticketPrs.byTicket(key).filter((r) => !onlyPrs || onlyPrs.has(prUrlKey(r.url)));
      const pathOf = (repoId: number) => d.tickets.getRepo(repoId)?.repoPath ?? null;
      // 公共分支（BTL-270 审查）：仓库的默认分支和 main / master。从那里开的 PR 不是哪个 ticket 自己的，就算 ticket 记的分支也叫这个。
      // 几个仓库的默认分支并发读。
      const repoIds = [...new Set(rows.filter((r) => r.state === "open" && r.repoId !== null).map((r) => r.repoId!))];
      const defaults = new Map<number, Set<string>>(
        await Promise.all(repoIds.map(async (repoId): Promise<[number, Set<string>]> => {
          const repoPath = pathOf(repoId);
          const names = new Set(ALWAYS_PUBLIC);
          if (repoPath) {
            try {
              names.add(await d.defaultBranch(repoPath));
            } catch (e) {
              d.log(`ticket ${key}: reading the default branch of ${repoPath} failed`, e);
            }
          }
          return [repoId, names];
        })),
      );
      // 是不是同一个仓库：按 slug 比（同一个仓库的两个 clone、worktree 路径不同），哪边的 slug 读不到再按路径比。
      const slugs = new Map<string, string | null>();
      const slugAt = (path: string) => {
        if (!slugs.has(path)) slugs.set(path, d.slugOf(path));
        return slugs.get(path) ?? null;
      };
      const sameRepo = (a: string, b: string | null): boolean => {
        if (b === null) return false;
        const sa = slugAt(a);
        const sb = slugAt(b);
        return sa !== null && sb !== null ? sa === sb : a === b;
      };
      // 同一个仓库里别的 ticket 也用过的分支名（develop 这种）：不知道这个 PR 是谁的，不替它关，报出是哪个 ticket（shared_branch）。
      // ticket_repos 的 id 是每个 ticket 一行，所以按仓库比，不同仓库的同名分支不算。
      const usedByOthers = (repoId: number, branch: string): string | null => {
        const repoPath = pathOf(repoId);
        if (repoPath === null) return null;
        return d.tickets.reposOnBranch(branch).find((r) => r.ticketKey !== key && sameRepo(repoPath, r.repoPath))?.ticketKey ??
          d.branchOwners.byBranch(branch).find((o) => o.ticketKey !== key && sameRepo(repoPath, pathOf(o.repoId)))?.ticketKey ?? null;
      };
      const isPublic = (repoId: number, branch: string) => defaults.get(repoId)?.has(branch) ?? false;
      // ticket 仓库的分支，和 session 推过、记了归属的分支（worktree 里的子 session）。
      const own = (repoId: number, branch: string) => (t?.repos.some((r) => r.id === repoId && r.branch === branch) ?? false) || d.branchOwners.get(key, repoId, branch) !== null;
      const first = classifyOpenPrs<TicketPr>(rows, {
        givenUp: (p) => prGivenUp(p),
        ownBranch: own,
        publicBranch: isPublic,
        sharedBranch: usedByOthers,
        // 同一个 PR 也挂在别的 ticket 上（关了的也算：那个 ticket 重新打开时还要用这个 PR）：不替那个 ticket 关。
        sharedWith: (p) => d.ticketPrs.byUrl(p.url).map((r) => r.ticketKey).find((k) => k !== key) ?? null,
        ghDir: (p) => d.ghDir(p),
      });
      const byUrl = new Map(rows.map((r) => [r.url, r]));
      return verifyHeads(d, first, (pr, h) => {
        const repoId = byUrl.get(pr.url)?.repoId ?? null;
        if (repoId === null) return { kind: "not_own_branch" };
        // head 仓库的 owner 要和 ticket 仓库（origin）的 owner 一样（BTL-270 审查）：fork 流程里 origin 是 me/app、PR 开到 org/app，
        // head 在 me 下也算本 ticket 的（crossRepo 也行）；别人 fork 上的、head 仓库删了的不是。owner 不知道（slug 都读不到）就不关。
        const repoPath = pathOf(repoId);
        const ticketSlug = (repoPath === null ? null : slugAt(repoPath)) ?? pr.slug;
        if (ticketSlug === null || h.headOwner === null || h.headOwner.toLowerCase() !== slugOwner(ticketSlug)) return { kind: "not_own_branch" };
        // 用这次读到的实时分支名、实时目标分支再判断一次，不用行里记的。
        if (h.headBranch === h.baseBranch || isPublic(repoId, h.headBranch) || !own(repoId, h.headBranch)) return { kind: "not_own_branch" };
        const other = usedByOthers(repoId, h.headBranch);
        return other === null ? null : { kind: "shared_branch", ticket: other };
      });
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

/** slug（owner/name，企业版前面带主机）的 owner，小写。 */
const slugOwner = (slug: string): string => (slug.split("/").at(-2) ?? "").toLowerCase();

/**
 * 能关的再用 gh 实时核对一次 head（BTL-270 审查），并发跑：whyNot 给了原因的（别人 fork 上的、分支名或目标分支对不上、别的 ticket 也用这个分支名）不关；
 * 已经不开着的不列。核对失败（gh 失败、超时、gh 太老）是可以重试的 unverified：不去关一个没核对过的 PR，但重试时会再核对。
 */
async function verifyHeads(
  d: CloseWiringDeps, open: OpenPrs, whyNot: (pr: OpenPrs["closable"][number], h: PrHead) => { kind: UnclosableKind; ticket?: string } | null,
): Promise<OpenPrs> {
  const heads = await Promise.all(
    open.closable.map((pr) =>
      d.prHead(pr.cwd, pr.url, CLOSE_VERIFY_TIMEOUT_MS).catch((e: unknown): PrHeadError => ({ error: e instanceof Error ? e.message : String(e) })),
    ),
  );
  const closable: OpenPrs["closable"] = [];
  const unclosable: UnclosablePr[] = [...open.unclosable];
  open.closable.forEach((pr, i) => {
    const h = heads[i];
    if ("error" in h) {
      d.log(`checking the head of ${pr.url} failed: ${h.error}`);
      const error = h.ghTooOld ? M().ticketCloseGhTooOld(h.error) : M().ticketCloseVerifyFailed(h.error);
      unclosable.push({ url: pr.url, number: pr.number, kind: "unverified", error });
    } else if (h.open) {
      const no = whyNot(pr, h);
      if (no) unclosable.push({ url: pr.url, number: pr.number, ...no });
      else closable.push(pr);
    }
  });
  return { closable, unclosable };
}
