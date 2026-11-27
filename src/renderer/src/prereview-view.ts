// 预审徽标、队列页、侧栏指示的文字（BTL-271）。纯函数：传进 S 和 now，测试里两种语言都能跑。
import type { PreReviewBadge, PreReviewQueueView } from "../../shared/prereview";
import type { UiStrings } from "./strings";

export type PreReviewTone = "muted" | "info" | "warn" | "bad" | "good";

export interface PreReviewChipView {
  state: PreReviewBadge["state"];
  label: string;
  tone: PreReviewTone;
  /** 悬停时的详情：在等什么、哪份代码、上一次的结论、出错的说明。 */
  title: string;
}

const clock = (ms: number): string => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 没做完的那类的结论文字（「上一次：违规 2 条」也用它）。 */
function verdictLabel(state: "clean" | "violations" | "error", violations: number, S: UiStrings): string {
  return state === "clean" ? S.prq.clean : state === "violations" ? S.prq.violations(violations) : S.prq.error;
}

/** 一枚徽标：未预审、排队 #N、预审中 N 分钟、通过、违规 N 条、出错、暂停（原因）。 */
export function preReviewChip(b: PreReviewBadge, now: number, S: UiStrings): PreReviewChipView {
  const P = S.prq;
  const lines: string[] = [];
  if (b.repoSlug && b.branch && b.headSha) lines.push(P.code(b.repoSlug, b.branch, b.headSha.slice(0, 7)));
  let label: string;
  let tone: PreReviewTone;
  switch (b.state) {
    case "none":
      label = P.none;
      tone = "muted";
      break;
    case "queued":
      label = P.queued(b.position);
      tone = "info";
      if (b.waiting) lines.push(P.waiting[b.waiting]);
      if (b.enqueuedAt) lines.push(P.enqueued(clock(b.enqueuedAt)));
      break;
    case "paused": {
      const reason = b.reason ? P.reason[b.reason] : "";
      label = P.paused(reason);
      tone = "warn";
      if (b.until) lines.push(P.until(clock(b.until)));
      break;
    }
    case "running":
      label = P.running(b.startedAt !== null ? Math.max(0, Math.floor((now - b.startedAt) / 60_000)) : 0);
      tone = "info";
      if (b.startedAt) lines.push(P.started(clock(b.startedAt)));
      break;
    case "clean":
      label = P.clean;
      tone = "good";
      break;
    case "violations":
      label = P.violations(b.violations);
      tone = "bad";
      break;
    case "error":
      label = P.error;
      tone = "bad";
      if (b.detail) lines.push(b.detail);
      break;
  }
  if (b.trigger) lines.push(P.trigger[b.trigger]);
  if (b.last) lines.push(P.last(verdictLabel(b.last.state, b.last.violations, S)));
  return { state: b.state, label, tone, title: lines.join("\n") };
}

/** 侧栏的「预审 1 个进行中 · 2 个排队」；什么都没有、也没停着时为 null（不占位置）。 */
export function preReviewSidebarText(q: PreReviewQueueView, S: UiStrings): string | null {
  const counts = S.prq.sidebar(q.running.length, q.queued.length);
  const stopped = q.stopped && q.queued.length > 0 ? S.prq.sidebarStopped(S.prq.reason[q.stopped.reason]) : "";
  const text = [counts, stopped].filter(Boolean).join(" · ");
  return text ? `${S.prq.sidebarLabel} ${text}` : null;
}

/** 队列页顶上的「队列停着」那一句；没停为 null。 */
export function preReviewStoppedText(q: PreReviewQueueView, S: UiStrings): string | null {
  if (!q.stopped) return null;
  const reason = S.prq.reason[q.stopped.reason];
  return q.stopped.until ? S.prq.stoppedUntil(reason, clock(q.stopped.until)) : S.prq.stopped(reason);
}

export const preReviewClock = clock;
