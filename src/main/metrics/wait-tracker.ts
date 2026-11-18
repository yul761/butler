import type { ActivityKind } from "../../shared/activity";
import type { InterruptCategory } from "../../shared/metrics";
import type { MetricsRepo, WaitKind } from "../db/metrics-repo";
import { busy, type AnsweredWhat } from "./interventions";

/** 状态没变时多久写一次 last_seen_at（Butler 突然退出时，段按它关）。 */
export const TOUCH_MS = 30_000;
/**
 * 两次 sync 隔了这么久：中间电脑睡着了（或者主进程卡住了），那段时间 Butler 没在跑，不算等待。
 * 段在最后看到的时间关掉，醒来那一刻重新开。sync 至少每 TOUCH_MS 一次，留出定时器的抖动。
 */
export const GAP_MS = 3 * TOUCH_MS;

export type WaitSource = "permission_prompt" | "question_tool" | "ask_user" | "needs_you";

/** 一个开着终端的 Butler head 此刻的样子。 */
export interface WaitHead {
  id: string;
  ticketKey: string | null;
  /** 停着等输入。 */
  waiting: boolean;
  hibernated: boolean;
  kind: ActivityKind | null;
  /** 终端停在权限确认上。 */
  permission: boolean;
  /** 停在 AskUserQuestion / ExitPlanMode 上（approval 而且工具在跑，见 questionToolShowing）。 */
  questionTool: boolean;
  /** 有未决的 ask_user：它的类别（还没分出来为 null）；没有为 undefined。 */
  ask?: InterruptCategory | null;
  /** 被判断成需要你：类别；不需要为 null。 */
  needsYou: InterruptCategory | null;
}

export interface WaitState {
  kind: WaitKind;
  category: InterruptCategory | null;
  source: WaitSource | null;
}

/** 此刻在等什么：在等人（按优先级）、空闲，或者不算（在干活、休眠）。 */
export function waitStateOf(h: WaitHead): WaitState | null {
  if (h.hibernated) return null;
  if (h.permission) return { kind: "human", category: "permission", source: "permission_prompt" };
  if (h.questionTool) return { kind: "human", category: "choice", source: "question_tool" };
  // ask_user 和「需要你」只在停下来时算：没答的条目挂着、session 接着在干别的（总控常这样），不算在等人。
  if (!h.waiting || busy(h.kind)) return null;
  if (h.ask !== undefined) return { kind: "human", category: h.ask ?? "question", source: "ask_user" };
  if (h.needsYou) return { kind: "human", category: h.needsYou, source: "needs_you" };
  if (h.kind === null || h.kind === "waiting" || h.kind === "idle") return { kind: "idle", category: null, source: null };
  return null;
}

const ANSWERED: Record<WaitSource, AnsweredWhat> = {
  permission_prompt: "permission", question_tool: "choice", ask_user: "ask_user", needs_you: "needs_you",
};

export interface WaitTrackerDeps {
  repo: Pick<MetricsRepo, "openSpan" | "touchSpan" | "closeSpan" | "closeStale" | "setSpanCategory">;
  heads(): WaitHead[];
  now(): number;
  /** 开了一个在等人的段（打断原因：权限确认、AskUserQuestion 在这里记）。 */
  onHumanSpan?(spanId: number, head: WaitHead, state: WaitState): void;
  log?: (msg: string, err?: unknown) => void;
}

interface Open {
  spanId: number;
  state: WaitState;
  touchedAt: number;
  /** 最后一次 sync 看到它的时间（只在内存里）。 */
  seenAt: number;
}

/**
 * 等人时间（ws-h）：activity-monitor 只知道此刻，这里把"在等人 / 空闲"记成一段一段（metrics_wait_spans）。
 * 休眠的、终端关了的、在干活的不算等待。
 */
export class WaitTracker {
  private readonly open = new Map<string, Open>();

  constructor(private readonly d: WaitTrackerDeps) {}

  /** 启动时调一次：上次没关的段按最后看到的时间关掉。 */
  recover(): number {
    return this.d.repo.closeStale();
  }

  /** 每个活动 tick 调。不抛。 */
  sync(): void {
    const now = this.d.now();
    try {
      this.splitGaps(now);
      const heads = this.d.heads();
      const seen = new Set<string>();
      for (const h of heads) {
        seen.add(h.id);
        this.apply(h, waitStateOf(h), now);
      }
      for (const id of [...this.open.keys()]) if (!seen.has(id)) this.close(id, now);
    } catch (e) {
      this.d.log?.("metrics: syncing wait spans failed", e);
    }
  }

  /** 这个 session 现在在等人什么（人在终端里回答时标上答的是什么）。 */
  waitingFor(sessionId: string): AnsweredWhat | null {
    const o = this.open.get(sessionId);
    return o?.state.kind === "human" && o.state.source ? ANSWERED[o.state.source] : null;
  }

  /** 退出前、电脑要睡了：开着的段都关掉（醒来后下一次 sync 按那时的状态重新开）。不抛。 */
  closeAll(): void {
    const now = this.d.now();
    try {
      for (const id of [...this.open.keys()]) this.close(id, now);
    } catch (e) {
      this.d.log?.("metrics: closing wait spans failed", e);
    }
  }

  /** 隔了 GAP_MS 以上没看到的段（睡眠、主进程卡住）：在最后看到的时间关掉，这次 sync 再按现在的状态开新的。 */
  private splitGaps(now: number): void {
    for (const [id, cur] of [...this.open]) {
      if (now - cur.seenAt <= GAP_MS) continue;
      this.open.delete(id);
      this.d.repo.closeSpan(cur.spanId, cur.seenAt);
    }
  }

  private apply(h: WaitHead, state: WaitState | null, now: number): void {
    const cur = this.open.get(h.id);
    if (cur && state && cur.state.kind === state.kind && cur.state.source === state.source) {
      cur.seenAt = now;
      if (state.category !== cur.state.category && state.category !== null) {
        this.d.repo.setSpanCategory(cur.spanId, state.category);
        cur.state = state;
      }
      if (now - cur.touchedAt >= TOUCH_MS) {
        this.d.repo.touchSpan(cur.spanId, now);
        cur.touchedAt = now;
      }
      return;
    }
    if (cur) this.close(h.id, now);
    if (!state) return;
    const spanId = this.d.repo.openSpan({ sessionId: h.id, ticketKey: h.ticketKey, kind: state.kind, category: state.category, source: state.source, startedAt: now });
    this.open.set(h.id, { spanId, state, touchedAt: now, seenAt: now });
    if (state.kind === "human") this.d.onHumanSpan?.(spanId, h, state);
  }

  private close(id: string, now: number): void {
    const cur = this.open.get(id);
    if (!cur) return;
    this.open.delete(id);
    this.d.repo.closeSpan(cur.spanId, now);
  }
}
