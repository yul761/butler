import type { MergeGateRepo, MergeHold } from "../db/merge-gate-repo";
import { M } from "../strings";
import type { prInfo } from "../tickets/gh";
import type * as Git from "../tickets/git";
import { HOLD_MAX_MS } from "./merge-gate";

/**
 * 本地合并、直接 push 的占位最多留多久。正常在 post 阶段就定下来了；没收到 post（权限提示被拒、按了 Esc、hook 超时）时
 * 命令其实没跑，不能让冲突的一方等 2 小时（最终审查 2）。
 */
export const LOCAL_HOLD_MAX_MS = 10 * 60_000;
/** 拿到许可 30 秒后 PR 还开着、又没开自动合并：合并命令失败了，或者 --auto 被取消了。 */
const PR_GRACE_MS = 30_000;
/** gh 和 fetch 各给 2 秒：一轮检查不能拖太久。 */
const PR_TIMEOUT_MS = 2000;
const FETCH_TIMEOUT_MS = 2000;
/** soon() 等这么久再查：合并多次调用，也给 GitHub 一点时间。 */
const SOON_MS = 1000;

type Outcome = "merged" | "cancelled" | "expired";
type Notice = ReturnType<MergeGateRepo["pendingNotices"]>[number];

export interface HoldWatcherDeps {
  repo: MergeGateRepo;
  prInfo: typeof prInfo;
  git: Pick<typeof Git, "isAncestor" | "fetchQuiet" | "upstreamRef">;
  /** sessionId 是等待者的 BUTLER_SESSION（打开终端时的 id）。 */
  isOpen(sessionId: string): boolean;
  /** 这个终端里的 claude 停着等输入（不在忙）。 */
  isWaiting(sessionId: string): boolean;
  deliver(sessionId: string, text: string): Promise<"sent" | "exited" | "timeout">;
  /** 和 MergeGate 用同一个函数。 */
  whoOf(ticketKey: string | null, branch: string): string;
  now(): number;
  log(msg: string, err?: unknown): void;
}

/**
 * 占位跟着真正的合并走（设计文档 2026-11-04“占位跟着真正的合并走”“回复和之后的事”）：定期查占位中的合并，
 * 真的合完就释放、告诉等着的 session 可以合了；PR 关了、自动合并取消了就释放；查不了的 PR 最多留 2 小时，本地合并、直接 push 最多留 10 分钟。
 * 所有状态都在数据库里，Butler 重启后照样接上。
 */
export class HoldWatcher {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  /** 正在发的通知（deliver 可能要等一会儿）：一轮检查和 Stop 同时到时不发两遍。 */
  private readonly delivering = new Set<number>();

  constructor(private readonly d: HoldWatcherDeps) {}

  /** 一轮：释放占位 + 发待发的通知。永不 reject；进行中再调用就合并成这一轮。 */
  check(): Promise<void> {
    this.running ??= this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * Stop hook 到了：有停下来的 session 就把待发的通知过一遍（每条仍然只发给开着、停着等输入的 session）。
   * 不只发给 sessionId：Butler 重开过的终端用的是链上最新的 id，和等待者记下的 BUTLER_SESSION 可能对不上。
   */
  async sessionIdle(sessionId: string): Promise<void> {
    try {
      await this.sendNotices();
    } catch (e) {
      this.d.log(`merge gate: sending notices after ${sessionId} stopped failed`, e);
    }
  }

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref?.();
    // 启动时先查一轮：Butler 没开着的时候可能已经合完了。
    this.soon();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.soonTimer) clearTimeout(this.soonTimer);
    this.soonTimer = null;
  }

  /** MergeGate 的 checkSoon：1 秒后跑一轮 check（合并多次调用）。 */
  soon(): void {
    if (this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      void this.check();
    }, SOON_MS);
    this.soonTimer.unref?.();
  }

  private async round(): Promise<void> {
    try {
      // 并行：每个 PR 的 gh 最多 2 秒，逐个查占位多时一轮会很长。
      await Promise.all(this.d.repo.activeHolds().map((h) => this.settle(h)));
      await this.sendNotices();
    } catch (e) {
      this.d.log("merge gate: checking holds failed", e);
    }
  }

  private async settle(h: MergeHold): Promise<void> {
    try {
      const outcome = await this.outcomeOf(h);
      if (!outcome) return;
      this.d.repo.releaseHold(h.id, outcome, this.d.now());
      this.d.log(`merge gate: hold on ${h.branch} → ${h.target} in ${h.repoPath} released (${outcome})`);
    } catch (e) {
      this.d.log(`merge gate: checking the hold on ${h.branch} → ${h.target} in ${h.repoPath} failed`, e);
    }
  }

  /** 这个占位现在该怎么释放；还要继续占着返回 null。 */
  private async outcomeOf(h: MergeHold): Promise<Outcome | null> {
    const age = this.d.now() - h.createdAt;
    const g = this.d.git;
    if (h.kind === "pr") {
      const pr = h.prUrl ? await this.d.prInfo(h.repoPath, h.prUrl, PR_TIMEOUT_MS) : null;
      if (pr) {
        if (pr.state === "MERGED") return "merged";
        if (pr.state === "CLOSED") return "cancelled";
        if (!pr.autoMerge && age > PR_GRACE_MS) return "cancelled";
        // 自动合并、合并队列：gh 查得到就一直等，不按时间作废。
        return null;
      }
      // gh 查不了（没装、没登录、没网）：看 branch 是不是已经进了最新的目标分支。
      await g.fetchQuiet(h.repoPath, h.target, FETCH_TIMEOUT_MS);
      if (await g.isAncestor(h.repoPath, h.branch, await g.upstreamRef(h.repoPath, h.target))) return "merged";
    } else {
      // 本地合并、直接 push 通常在 post 阶段就定下来了；这里接住没收到 post 的（hook 超时、Butler 重启）。
      // 直接 push 进的是 origin/<target>，本地的目标分支不会动，所以两个都看（不 fetch，push 之后远端引用已经更新了）。
      if (await g.isAncestor(h.repoPath, h.branch, h.target)) return "merged";
      const upstream = await g.upstreamRef(h.repoPath, h.target);
      if (upstream !== h.target && (await g.isAncestor(h.repoPath, h.branch, upstream))) return "merged";
    }
    return age > (h.kind === "local" ? LOCAL_HOLD_MAX_MS : HOLD_MAX_MS) ? "expired" : null;
  }

  private async sendNotices(): Promise<void> {
    for (const n of this.d.repo.pendingNotices()) await this.notice(n);
  }

  /** 发一条“X 已经合完”：session 关了就不再发；在忙就等它的 Stop（sessionIdle）。 */
  private async notice(n: Notice): Promise<void> {
    if (this.delivering.has(n.waiterId)) return;
    // 名单是这一轮开始时取的：前面某条 deliver 慢的时候，Stop（sessionIdle）可能已经把这条发掉了。从数据库重查一次再发。
    if (!this.d.repo.pendingNotices().some((p) => p.waiterId === n.waiterId)) return;
    if (!this.d.isOpen(n.sessionId)) {
      this.d.repo.markNotified(n.waiterId, this.d.now());
      this.d.log(`merge gate: session ${n.sessionId} is no longer open; not telling it that ${n.otherBranch} has merged`);
      return;
    }
    if (!this.d.isWaiting(n.sessionId)) return;
    this.delivering.add(n.waiterId);
    try {
      const res = await this.d.deliver(n.sessionId, M().gateMergedNotice(this.d.whoOf(n.otherTicket, n.otherBranch)));
      // exited：终端在发的时候关了，和“已经不开着”一样不再发。timeout：下一轮再试。
      if (res === "timeout") this.d.log(`merge gate: telling session ${n.sessionId} that ${n.otherBranch} has merged timed out; trying again later`);
      else this.d.repo.markNotified(n.waiterId, this.d.now());
    } catch (e) {
      this.d.log(`merge gate: telling session ${n.sessionId} that ${n.otherBranch} has merged failed`, e);
    } finally {
      this.delivering.delete(n.waiterId);
    }
  }
}
