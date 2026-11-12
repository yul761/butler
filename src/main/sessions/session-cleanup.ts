import type { SessionActivity } from "../../shared/activity";
import type { Session } from "../../shared/types";
import type { CloseTrigger, RefreshResult, SessionRefresher } from "./session-refresher";

/** 隐藏超过这么久的 session 行自动删掉（BTL-190 第 8 点）。 */
export const HIDDEN_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/** 多久查一次该删的隐藏 session：删除不急，一小时一次足够（启动后的第一次 tick 就查）。 */
export const PURGE_EVERY_MS = 60 * 60 * 1000;
/**
 * 「清理闲置」按钮不看 idleCloseMinutes，但停下不到这么久的不算闲置：用户刚问完、刚收到回复的那一个不能顺手关掉。
 */
export const MANUAL_IDLE_MS = 5 * 60 * 1000;

/** 一个开着的终端和它现在的 head（Butler 开的 session）。 */
export interface OpenTerminal {
  termId: string;
  head: Session;
}

export interface SessionCleanupDeps {
  /** 设置 idleCloseMinutes，0 = 不自动关。 */
  idleMinutes(): number;
  /** 开着终端的 Butler session（每个终端一个；/clear 之后是链上最新的 head）。 */
  terminals(): OpenTerminal[];
  /** 按 head 的 id 查。 */
  activity(headId: string): SessionActivity | null;
  /** 用户上一次往这个终端里输入的时间（PtyManager.lastUserInputAt），0 = 没输入过。 */
  lastUserInputAt(termId: string): number;
  /** 终端打开的时间（PtyManager.openedAt），0 = 不知道。 */
  openedAt(termId: string): number;
  /** feature 下面的 ticket 号：feature 总控管这些 ticket 的 session。 */
  ticketsOfFeature(featureId: number): string[];
  /** epic 下面的 feature：epic session 管这些 feature 的总控、修复 session 和它们 ticket 的 session。 */
  featuresOfEpic(epicId: number): number[];
  /**
   * 这个 session 有没有还没回答的 ask_user（BTL-190 第 2+3 点）。那一段还没做：不给就当作没有。
   * 做好以后在 index.ts 里接上，有未决的 ask_user 的 session 不关。
   */
  askUserPending?: (headId: string) => boolean;
  refresher: Pick<SessionRefresher, "precheckClose" | "close">;
  /** 隐藏着、隐藏和最后一次活动都早于 before 的 head（SessionsRepo.listHiddenBefore）。 */
  hiddenBefore(before: number): Session[];
  /** 这个 session 的 head（链上任何一个 id 都认）。 */
  head(sessionId: string): Session | null;
  /** 这条链上有没有开着的终端。 */
  terminalOpen(headId: string): boolean;
  /** 删掉整条链（SessionsRepo.deleteChain），返回删掉的 id。 */
  deleteChain(headId: string): string[];
  /** 删掉这个 id 的换新尾巴文件（~/.butler/refresh/<id>.md，BTL-190 第 6 点）；没有就算了。 */
  removeTail(sessionId: string): void;
  /** 自动删除删掉了东西：刷新界面。 */
  notify(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

/** 子 session 在干活：思考中、跑工具、后台命令（BTL-190 第 7 点的口径）。活动还没读到的也当作在干活：看不准就不关总控。 */
export function working(a: SessionActivity | null): boolean {
  return a === null || a.background || (a.kind !== "waiting" && a.kind !== "idle" && a.kind !== "approval");
}

/**
 * 清理 session（BTL-190 第 8 点）：
 * - 闲置自动关闭：开着终端、停下超过 idleCloseMinutes、换新的 guard 通过（不需要你、没在打字、没有草稿）、没有后台任务、
 *   没有未决的 ask_user、不在换新中，总控的话它管的子 session 都没在干活，就交给 SessionRefresher.close：写 handoff、等记忆写完、
 *   结束终端并隐藏。
 * - 隐藏超过 14 天的 session 行连同整条链、合并总控里没递出去的等待者和尾巴文件一起删掉。transcript 不动。
 * - 手动：「清理闲置」（closeIdle）和隐藏列表里的「全部删除」（deleteHidden）。
 */
export class SessionCleanup {
  private lastPurgeAt = 0;

  constructor(private readonly d: SessionCleanupDeps) {}

  /** 每个活动 tick 调一次：按设置关闭闲置的 session；每小时删一次过期的隐藏 session。 */
  tick(): void {
    const minutes = this.d.idleMinutes();
    if (minutes > 0) this.closeIdle(null, minutes * 60_000, "auto");
    if (this.lastPurgeAt === 0 || this.d.now() - this.lastPurgeAt >= PURGE_EVERY_MS) {
      this.lastPurgeAt = this.d.now();
      this.purgeHidden();
    }
  }

  /**
   * 「清理闲置」按钮：sessionIds 里（链上任何一个 id 都认）闲置的 session 现在就开始关，不看 idleCloseMinutes（0 也照样关），
   * 但要停下至少 MANUAL_IDLE_MS。返回开始关的个数；关闭在后台跑。
   */
  closeIdleNow(sessionIds: string[]): number {
    const heads = new Set(sessionIds.map((id) => this.d.head(id)?.id ?? id));
    return this.closeIdle(heads, MANUAL_IDLE_MS, "manual");
  }

  /** 现在闲置、可以关的 session 的 head id（only：只看这些 head）。 */
  idleSessions(only: ReadonlySet<string> | null, idleMs: number, trigger: CloseTrigger): string[] {
    const terms = this.d.terminals();
    const now = this.d.now();
    const out: string[] = [];
    for (const t of terms) {
      const h = t.head;
      if (out.includes(h.id) || (only && !only.has(h.id))) continue;
      if (now - this.idleSince(t) < idleMs) continue;
      if (this.d.askUserPending?.(h.id)) continue;
      if (this.childrenWorking(h, terms)) continue;
      // 种类（修复 session、非 Butler 的不关）、guard、后台任务、刚打开、正在换新、冷却都由换新那边同步回答。
      if (this.d.refresher.precheckClose(h.id, trigger) !== null) continue;
      out.push(h.id);
    }
    return out;
  }

  /**
   * 删掉隐藏的 session（隐藏列表里的「全部删除」）：sessionIds 里隐藏着、终端没开着的 head 连同整条链删掉。
   * 没隐藏的、被 /clear 替换过的旧 id、开着终端的不动。返回删掉的 session 个数（按 head 算）。
   */
  deleteHidden(sessionIds: string[]): number {
    let n = 0;
    for (const id of new Set(sessionIds)) {
      const h = this.d.head(id);
      if (!h || h.id !== id || !h.dismissed || this.d.terminalOpen(h.id)) continue;
      if (this.remove(h.id)) n++;
    }
    if (n > 0) this.d.log(`deleted ${n} hidden session(s) on request`);
    return n;
  }

  /** 隐藏超过 14 天（而且之后没有活动）的 session：删掉。返回删掉的个数。 */
  purgeHidden(): number {
    let n = 0;
    try {
      for (const s of this.d.hiddenBefore(this.d.now() - HIDDEN_KEEP_MS)) {
        if (this.d.terminalOpen(s.id)) continue;
        if (this.remove(s.id)) n++;
      }
    } catch (e) {
      this.d.log("session cleanup: deleting old hidden sessions failed", e);
    }
    if (n > 0) {
      this.d.log(`deleted ${n} session(s) hidden for more than ${HIDDEN_KEEP_MS / 86_400_000} days`);
      this.d.notify();
    }
    return n;
  }

  private closeIdle(only: ReadonlySet<string> | null, idleMs: number, trigger: CloseTrigger): number {
    const ids = this.idleSessions(only, idleMs, trigger);
    for (const id of ids) {
      this.d.log(`idle close ${id} (${trigger}): idle for ${Math.round((this.d.now() - this.idleSinceOf(id)) / 60_000)} min`);
      this.d.refresher.close(id, trigger).then(
        (r: RefreshResult) => {
          if (r !== "done") this.d.log(`idle close ${id}: ${r}`);
        },
        (e: unknown) => this.d.log(`idle close ${id} failed`, e),
      );
    }
    return ids.length;
  }

  /** 删一条链和它的尾巴文件；尾巴文件按链上每个 id 删（终端的 id 是打开它时的 head，可能是链上任何一段）。 */
  private remove(headId: string): boolean {
    const ids = this.d.deleteChain(headId);
    for (const id of ids) {
      try {
        this.d.removeTail(id);
      } catch (e) {
        this.d.log(`session cleanup: removing the refresh tail of ${id} failed`, e);
      }
    }
    return ids.length > 0;
  }

  /** 最后一次有动静的时间：停下的时间、transcript 最后的输出、用户在终端里输入、终端打开，取最晚的。 */
  private idleSince(t: OpenTerminal): number {
    const a = this.d.activity(t.head.id);
    return Math.max(t.head.lastActivityAt ?? 0, a?.lastOutputAt ?? 0, this.d.lastUserInputAt(t.termId), this.d.openedAt(t.termId));
  }

  private idleSinceOf(headId: string): number {
    const t = this.d.terminals().find((x) => x.head.id === headId);
    return t ? this.idleSince(t) : this.d.now();
  }

  /** 总控（ticket 总控、feature 总控、epic session）管的、开着终端的子 session 有没有在干活。不是总控的返回 false。 */
  private childrenWorking(coord: Session, terms: OpenTerminal[]): boolean {
    const manages = this.managedBy(coord);
    if (!manages) return false;
    return terms.some((t) => t.head.id !== coord.id && manages(t.head) && working(this.d.activity(t.head.id)));
  }

  /** 和总控的 end_session 范围一样（control-handler）：ticket 总控管同一个 ticket 的；feature 总控管它 ticket 的和修复 session；epic 管它 feature 的。 */
  private managedBy(coord: Session): ((s: Session) => boolean) | null {
    if (coord.epicId !== null) {
      const features = new Set(this.d.featuresOfEpic(coord.epicId));
      const keys = new Set([...features].flatMap((f) => this.d.ticketsOfFeature(f)));
      return (s) => (s.ticketKey !== null ? keys.has(s.ticketKey) : s.featureId !== null && features.has(s.featureId));
    }
    if (coord.ticketKey !== null) return coord.coordinator ? (s) => s.ticketKey === coord.ticketKey : null;
    if (coord.featureId !== null && coord.fixesSession === null) {
      const keys = new Set(this.d.ticketsOfFeature(coord.featureId));
      return (s) => (s.ticketKey !== null ? keys.has(s.ticketKey) : s.featureId === coord.featureId && s.fixesSession !== null);
    }
    return null;
  }
}
