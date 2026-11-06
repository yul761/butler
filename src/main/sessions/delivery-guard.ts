import type { SessionActivity } from "../../shared/activity";
import type { Session } from "../../shared/types";
import type { PtyManager } from "./pty-manager";

/** 用户这么久之内在终端里打过字就先不自动输入：贴进去再回车会把用户打了一半的话一起提交（合并总控最终审查 4）。 */
export const USER_TYPING_QUIET_MS = 30_000;

/** 现在不能往这个终端里自动输入的原因。 */
export type DeliveryBlock = "closed" | "busy" | "screen" | "needs_you" | "typing" | "draft";

export interface DeliveryGuardDeps {
  /** 跑着这个 session（链上任何一个 id）的终端；没有为 null。index.ts 里就是现在的 gateTerm。 */
  termOf(sessionId: string): string | null;
  head(sessionId: string): Session | null;
  /** 按 head 的 id 查。 */
  activity(sessionId: string): SessionActivity | null;
  pty: Pick<PtyManager, "lastUserInputAt" | "screenNeedsUser" | "hasDraft">;
  /** 计划 14 接上「需要你」；没接时恒为 false。 */
  needsYou?: (headId: string) => boolean;
  /** 打过字之后多久之内不自动输入，默认 USER_TYPING_QUIET_MS（e2e 用环境变量调短）。 */
  typingQuietMs?: number;
  now(): number;
}

export type DeliveryCheck = { ok: true; termId: string; headId: string } | { ok: false; block: DeliveryBlock };

/**
 * 所有自动输入（合并总控的通知、PR/CI 结果）都先过这一道：终端开着、session 停着等输入、屏幕上没有要用户回答的东西、
 * 不在「需要你」里、用户最近没打字、输入框里没有没发出去的草稿，才能往里贴。
 */
export class DeliveryGuard {
  constructor(private readonly d: DeliveryGuardDeps) {}

  check(sessionId: string): DeliveryCheck {
    const termId = this.d.termOf(sessionId);
    if (termId === null) return { ok: false, block: "closed" };
    const head = this.d.head(termId);
    if (!head || !this.quiet(head)) return { ok: false, block: "busy" };
    if (this.d.pty.screenNeedsUser(termId)) return { ok: false, block: "screen" };
    if (this.d.needsYou?.(head.id)) return { ok: false, block: "needs_you" };
    const typed = this.d.pty.lastUserInputAt(termId);
    if (typed > 0 && this.d.now() - typed < (this.d.typingQuietMs ?? USER_TYPING_QUIET_MS)) return { ok: false, block: "typing" };
    // 草稿不看时间：用户打了一半去干别的，过多久回车都会把通知和草稿一起提交。
    if (this.d.pty.hasDraft(termId)) return { ok: false, block: "draft" };
    return { ok: true, termId, headId: head.id };
  }

  /**
   * 停着等输入，并且活动是 waiting / idle；只剩后台任务在跑（这一轮已经结束，活动显示的是后台命令）也算停着。
   * 活动还没读到（终端刚打开、还没轮到）算忙：不知道它在干什么就不打断。
   */
  private quiet(head: Session): boolean {
    if (head.waitingForInput !== true) return false;
    const a = this.d.activity(head.id);
    return a !== null && (a.background || a.kind === "waiting" || a.kind === "idle");
  }
}
