import type { Session } from "../../shared/types";

/**
 * 休眠的判断（WS-M B、C，设计 §3–4）：都是纯函数，Hibernator 每次 tick 把现状填进来。
 */

/** session 停下来以后在等什么：每种有自己的分钟数设置。 */
export type WaitState = "you" | "ci" | "review" | "idle";

export interface WaitInput {
  /** 「需要你」有原因，或者有没回答的 ask_user。屏幕上的权限确认不算（那种不休眠，见 hibernateBlock）。 */
  needsYou: boolean;
  /** 在等 CI：PR（或者还没开 PR 的分支）的 CI 在跑，或者排在合并总控里。和闲置关闭的 waitingOnButler 一样。 */
  ciPending: boolean;
  /** PR 开着、CI 不在跑、review 还没批准。 */
  reviewPending: boolean;
}

export function waitState(w: WaitInput): WaitState {
  if (w.needsYou) return "you";
  if (w.ciPending) return "ci";
  if (w.reviewPending) return "review";
  return "idle";
}

/** 刚打开的不休眠：claude 刚起来，用户多半要用它。 */
export const HIBERNATE_OPEN_QUIET_MS = 2 * 60_000;
/** 刚唤醒的不休眠：CI 结果一条接一条来时不会醒了又睡、睡了又醒。 */
export const HIBERNATE_WAKE_QUIET_MS = 10 * 60_000;
/** 内存紧张时最少闲置这么久才休眠，不看 B 的分钟数。 */
export const PRESSURE_MIN_IDLE_MS = 5 * 60_000;
/** 内存紧张的滞回：回到线以上这么多个百分点才停。 */
export const PRESSURE_HYSTERESIS_PERCENT = 5;

/** 一个开着终端、可能要休眠的 head 的现状。 */
export interface HibernateCandidate {
  head: Session;
  termId: string;
  /** 「钉住」。 */
  pinned: boolean;
  /** transcriptState(head.id)：只有 present 才能 --resume。 */
  transcript: "present" | "absent" | "unknown";
  /** 活动：null 是还没读到（当作在干活）。 */
  activity: { working: boolean; background: boolean } | null;
  /** 屏幕上有权限确认或对话框（--resume 会丢掉等着的权限确认）。 */
  screenNeedsUser: boolean;
  /** 输入框里有草稿。 */
  draft: boolean;
  /** 用户在 typing quiet 窗口里打过字。 */
  typing: boolean;
  /** Butler 正在往里递东西，或者占住了这个终端（pty.reserve）。 */
  autoInput: boolean;
  /** 正在换新或者闲置关闭。 */
  refreshing: boolean;
  /** 渲染进程里看得见这个终端。 */
  visible: boolean;
  /** 总控管的子 session 在干活。 */
  childrenWorking: boolean;
  /** 终端打开的时间；0 = 不知道。 */
  openedAt: number;
  /** 上次唤醒的时间；0 = 没唤醒过。 */
  wokeAt: number;
  /** 最后一次有动静的时间（和闲置关闭的 idleSince 一样）。 */
  idleSince: number;
}

export type HibernateBlock =
  | "pinned" | "kind" | "transcript" | "working" | "screen" | "draft" | "typing" | "auto_input" | "refreshing" | "visible" | "children"
  | "just_opened" | "just_woken";

/** 能休眠的种类：Butler 开的 ticket session、feature 总控、Butler 总控。修复 session 和复盘分析的不行。 */
export function hibernatableKind(s: Session): boolean {
  if (s.origin !== "butler" || s.fixesSession !== null || s.lessonRunId !== null) return false;
  return s.butler || s.featureId !== null || s.ticketKey !== null;
}

/** 刚打开、刚唤醒的安静期（e2e 调短）。 */
export interface HibernateQuiet {
  openMs?: number;
  wakeMs?: number;
}

/** 为什么现在不能休眠；null 表示可以。顺序只影响日志里报哪一条。 */
export function hibernateBlock(c: HibernateCandidate, now: number, q: HibernateQuiet = {}): HibernateBlock | null {
  if (c.pinned) return "pinned";
  if (!hibernatableKind(c.head)) return "kind";
  if (c.transcript !== "present") return "transcript";
  if (c.activity === null || c.activity.working || c.activity.background) return "working";
  if (c.screenNeedsUser) return "screen";
  if (c.draft) return "draft";
  if (c.typing) return "typing";
  if (c.autoInput) return "auto_input";
  if (c.refreshing) return "refreshing";
  if (c.visible) return "visible";
  if (c.childrenWorking) return "children";
  if (c.openedAt > 0 && now - c.openedAt < (q.openMs ?? HIBERNATE_OPEN_QUIET_MS)) return "just_opened";
  if (c.wokeAt > 0 && now - c.wokeAt < (q.wakeMs ?? HIBERNATE_WAKE_QUIET_MS)) return "just_woken";
  return null;
}

/** 停够了没有：minutes 是这种等待的设置，0 = 这种不休眠。 */
export function hibernateDue(c: HibernateCandidate, minutes: number, now: number): boolean {
  return minutes > 0 && now - c.idleSince >= minutes * 60_000;
}

/** 内存紧张时休眠哪一个：通过所有排除规则、闲置至少 PRESSURE_MIN_IDLE_MS 里闲得最久的；没有返回 null。 */
export function pressureVictim(cands: readonly HibernateCandidate[], now: number, q: HibernateQuiet = {}): HibernateCandidate | null {
  let best: HibernateCandidate | null = null;
  for (const c of cands) {
    if (now - c.idleSince < PRESSURE_MIN_IDLE_MS || hibernateBlock(c, now, q) !== null) continue;
    if (!best || c.idleSince < best.idleSince) best = c;
  }
  return best;
}

/** 内存是不是紧张（带滞回）：低于线就紧张；已经紧张的要回到线 + 5 以上才算缓过来。 */
export function underPressure(wasUnder: boolean, freePercent: number, line: number): boolean {
  if (freePercent < line) return true;
  return wasUnder && freePercent < line + PRESSURE_HYSTERESIS_PERCENT;
}
