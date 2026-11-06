import type { PrWatchRepo, PrWatchRow } from "../db/pr-watch-repo";
import type { CiCheck, branchRuns, failedLog, prStatus } from "../tickets/gh";
import type { WatchedPr } from "../../shared/types";

/** 有检查在跑、session 开着：每分钟查一次。 */
export const PR_FAST_MS = 60_000;
/** 其余每 5 分钟查一次。 */
export const PR_SLOW_MS = 300_000;
/** 同时跟踪的分支最多这么多个，超出时优先保留 session 开着的。 */
export const PR_WATCH_MAX = 40;
/** 每次 gh 调用的超时。 */
export const PR_GH_TIMEOUT_MS = 5000;
/** 失败日志取最后这么多行。 */
export const CI_LOG_LINES = 60;
/** 每次最多取这么多个失败 run 的日志。 */
const FAILED_LOGS_MAX = 3;
/** 同时跑的 gh 最多这么多个。 */
const GH_PARALLEL = 4;
/** soon() 等这么久再查：合并多次调用。 */
const SOON_MS = 1000;
/** cachedByUrl 只认这么久之内查过的。 */
const CACHE_FRESH_MS = 60_000;

export interface PrTarget {
  ticketKey: string;
  repoId: number;
  repoPath: string;
  cwd: string;
  branch: string;
  sessionOpen: boolean;
}

export interface PrWatcherDeps {
  repo: Pick<PrWatchRepo, "upsert" | "get" | "byTicket" | "all">;
  /** 要查的分支：未归档 ticket 的每个仓库，条件是这个仓库的 session 开着，或者 pr_watch 里它的 PR 还开着、或还没查过但 ticket 最新 handoff 里有开着的 PR。 */
  targets(): PrTarget[];
  gh: { prStatus: typeof prStatus; branchRuns: typeof branchRuns; failedLog: typeof failedLog };
  /** PR 的状态或 review 变了：把这个 ticket 所有仓库的 PR 写成一条 refresh handoff。 */
  onPrChanged(ticketKey: string): void;
  /** CI 有了新的结论（Task 6 接上）。 */
  onCiSettled(row: PrWatchRow): void;
  notify(): void;
  /** 每一轮结束后（不管查没查、成没成）：主进程用它再递一遍还没递出去的 CI 结论（session 刚安静下来）。 */
  roundDone?(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

const STATES = { OPEN: "open", MERGED: "merged", CLOSED: "closed" } as const;

/** 纯函数：一个仓库下次该查的时间。没查过的马上查；已合并、已关闭的不再查。 */
export function nextCheckAt(row: PrWatchRow | null, sessionOpen: boolean): number {
  if (!row) return 0;
  if (row.state === "merged" || row.state === "closed") return Infinity;
  return row.checkedAt + (row.ci === "pending" && sessionOpen ? PR_FAST_MS : PR_SLOW_MS);
}

/** 纯函数：超出上限时先留 session 开着的，其余保持原来的顺序。 */
function capped(targets: PrTarget[]): PrTarget[] {
  return [...targets.filter((t) => t.sessionOpen), ...targets.filter((t) => !t.sessionOpen)].slice(0, PR_WATCH_MAX);
}

/** 纯函数：有了结论（passing/failing），并且是第一次看到、之前没结论、换了提交，或者同一个提交结论变了。 */
function settled(prev: PrWatchRow | null, next: Omit<PrWatchRow, "deliveredKey">): boolean {
  if (next.ci !== "passing" && next.ci !== "failing") return false;
  return !prev || prev.headSha !== next.headSha || prev.ci !== next.ci;
}

/** 页面关心的字段（不含 checkedAt）有没有变。 */
function changed(prev: PrWatchRow | null, next: Omit<PrWatchRow, "deliveredKey">): boolean {
  if (!prev) return true;
  const keys = ["number", "url", "state", "review", "ci", "headSha"] as const;
  return keys.some((k) => prev[k] !== next[k]) || JSON.stringify(prev.failed) !== JSON.stringify(next.failed);
}

function toWatched(r: PrWatchRow): WatchedPr {
  return {
    ticketKey: r.ticketKey, repoId: r.repoId, repoPath: r.repoPath, branch: r.branch, number: r.number, url: r.url,
    state: r.state, review: r.review, ci: r.ci, headSha: r.headSha, checkedAt: r.checkedAt,
  };
}

/**
 * 按 ticket 的仓库和分支查 PR 和 CI（全部是代码，不调模型）：有 PR 用 gh pr view，没有就看分支的 workflow run。
 * 状态存进 pr_watch；PR 状态或 review 变了告诉 onPrChanged，CI 有了新结论告诉 onCiSettled。
 * 每 tick 看一遍谁到期了；一次只跑一轮；一轮里各仓库并行，但 gh 同时最多 4 个。
 */
export class PrWatcher {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  /** soon() 要求马上查的仓库。 */
  private dueNow = new Set<number>();
  private ghActive = 0;
  private readonly ghWaiting: (() => void)[] = [];

  constructor(private readonly d: PrWatcherDeps) {}

  start(tickMs = 15_000): void {
    this.stop();
    this.timer = setInterval(() => void this.check(), tickMs);
    this.timer.unref?.();
    // 启动时先查一轮：Butler 没开着的时候 PR 和 CI 可能都变了。
    void this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonTimer = null;
  }

  /** 立刻查这个仓库（session 刚 push、Stop 时用）：1 秒内跑一轮；正有一轮在跑就等它跑完再来一轮。 */
  soon(repoId: number): void {
    this.dueNow.add(repoId);
    if (this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.check().then(() => {
        // 赶上的是已经在跑的那一轮，它没带上这个仓库。
        if (this.dueNow.size > 0) void this.check();
      });
    }, SOON_MS);
    this.soonTimer.unref?.();
  }

  /** 一轮：查所有到期的仓库。永不 reject；进行中再调用就合并成这一轮。 */
  check(): Promise<void> {
    this.running ??= this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  statusOf(ticketKey: string): WatchedPr[] {
    return this.d.repo.byTicket(ticketKey).map(toWatched);
  }

  /** 给 HoldWatcher 用：PR url 对应的、60 秒内查过的状态；没有为 null。 */
  cachedByUrl(url: string): PrWatchRow | null {
    const now = this.d.now();
    const rows = this.d.repo.all().filter((r) => r.url === url && now - r.checkedAt <= CACHE_FRESH_MS);
    return rows.sort((a, b) => b.checkedAt - a.checkedAt)[0] ?? null;
  }

  private async round(): Promise<void> {
    try {
      const forced = this.dueNow;
      this.dueNow = new Set();
      const now = this.d.now();
      const due = capped(this.d.targets()).filter((t) => forced.has(t.repoId) || now >= nextCheckAt(this.rowOf(t), t.sessionOpen));
      const results = await Promise.all(due.map((t) => this.checkOne(t)));
      // 一个 ticket 的所有仓库都写完了再告诉 onPrChanged，而且只告诉一次。
      const prChanged = new Set(due.filter((_, i) => results[i]?.prChanged).map((t) => t.ticketKey));
      for (const key of prChanged) {
        try {
          this.d.onPrChanged(key);
        } catch (e) {
          this.d.log(`pr watch: updating ${key} after its PR changed failed`, e);
        }
      }
      if (results.some((r) => r?.changed)) this.d.notify();
    } catch (e) {
      this.d.log("pr watch: checking PRs failed", e);
    }
    try {
      this.d.roundDone?.();
    } catch (e) {
      this.d.log("pr watch: roundDone failed", e);
    }
  }

  /**
   * 这个仓库在 pr_watch 里的行。ticket 的分支改过（TicketsRepo.updateRepo）时行还是旧分支的：当作没查过（I4），
   * 不沿用旧分支的 PR、CI，也不因为旧分支的 PR 合并了就不再查。
   */
  private rowOf(t: PrTarget): PrWatchRow | null {
    const row = this.d.repo.get(t.repoId);
    return row && row.branch === t.branch ? row : null;
  }

  /** 查一个仓库、写进 pr_watch；出错记日志、返回 null。 */
  private async checkOne(t: PrTarget): Promise<{ prChanged: boolean; changed: boolean } | null> {
    try {
      const prev = this.rowOf(t);
      const next = await this.read(t, prev);
      this.d.repo.upsert(next);
      if (settled(prev, next)) {
        const row = this.d.repo.get(t.repoId);
        if (row) {
          try {
            this.d.onCiSettled(row);
          } catch (e) {
            this.d.log(`pr watch: handing over the CI result of ${t.branch} in ${t.repoPath} failed`, e);
          }
        }
      }
      const prChanged = (prev?.state ?? null) !== next.state || (prev?.review ?? null) !== next.review;
      return { prChanged, changed: changed(prev, next) };
    } catch (e) {
      this.d.log(`pr watch: checking ${t.branch} in ${t.repoPath} failed`, e);
      return null;
    }
  }

  /** 这个仓库现在的状态。gh 不可用时 ci 记 unknown，其余沿用上次的。 */
  private async read(t: PrTarget, prev: PrWatchRow | null): Promise<Omit<PrWatchRow, "deliveredKey">> {
    const base = { ticketKey: t.ticketKey, repoId: t.repoId, repoPath: t.repoPath, branch: t.branch, checkedAt: this.d.now() };
    const pr = await this.gh(() => this.d.gh.prStatus(t.cwd, t.branch, PR_GH_TIMEOUT_MS));
    if (pr) {
      return {
        ...base, number: pr.number, url: pr.url, state: STATES[pr.state], review: pr.review, ci: pr.ci, headSha: pr.headSha,
        failed: pr.ci === "failing" ? await this.failedWithLogs(t.cwd, pr.checks) : [],
      };
    }
    // 见过 PR 的分支不会再“没有 PR”（gh pr view <branch> 也找得到合并、关闭的）：这里是 gh 失败了，不能当成 PR 没了。
    const runs = prev?.number == null ? await this.gh(() => this.d.gh.branchRuns(t.cwd, t.branch, PR_GH_TIMEOUT_MS)) : null;
    if (runs) {
      return {
        ...base, number: null, url: null, state: null, review: null, ci: runs.ci, headSha: runs.headSha,
        failed: runs.ci === "failing" ? await this.failedWithLogs(t.cwd, runs.checks) : [],
      };
    }
    return {
      ...base, number: prev?.number ?? null, url: prev?.url ?? null, state: prev?.state ?? null, review: prev?.review ?? null,
      ci: "unknown", headSha: prev?.headSha ?? null, failed: prev?.failed ?? [],
    };
  }

  /** 失败的检查；最多取 3 个 run 的日志。同一个 run 的几个 job 共用一份日志，只取一次、挂在第一个上，免得重复。 */
  private async failedWithLogs(cwd: string, checks: CiCheck[]): Promise<CiCheck[]> {
    const fetched = new Set<number>();
    const out: CiCheck[] = [];
    for (const c of checks) {
      if (c.state !== "failing") continue;
      if (c.runId === null || fetched.has(c.runId) || fetched.size >= FAILED_LOGS_MAX) {
        out.push({ ...c });
        continue;
      }
      const runId = c.runId;
      fetched.add(runId);
      const log = await this.gh(() => this.d.gh.failedLog(cwd, runId, CI_LOG_LINES, PR_GH_TIMEOUT_MS));
      out.push(log === null ? { ...c } : { ...c, log });
    }
    return out;
  }

  /** 跑一个 gh 调用：同时最多 GH_PARALLEL 个；抛错当作失败（null），记日志。 */
  private async gh<T>(call: () => Promise<T | null>): Promise<T | null> {
    while (this.ghActive >= GH_PARALLEL) await new Promise<void>((r) => this.ghWaiting.push(r));
    this.ghActive++;
    try {
      return await call();
    } catch (e) {
      this.d.log("pr watch: gh call failed", e);
      return null;
    } finally {
      this.ghActive--;
      this.ghWaiting.shift()?.();
    }
  }
}
