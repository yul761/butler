import type { AvailabilityView } from "../../shared/availability";
import type { LessonRunStatus } from "../../shared/lessons";
import type { CiUndelivered, NowNotice } from "../../shared/types";

/** 连续这么多次分析失败才提醒。 */
export const LESSONS_FAILING_MIN = 3;

/** 不算分析本身成败的运行：被限额打断、用户取消、退出时中断。 */
const NEUTRAL: ReadonlySet<LessonRunStatus> = new Set(["limited", "cancelled", "aborted"]);

/** 「现在」页顶上的提醒：Claude 限额或模型不可用、模型路由的撞限和降级、复盘手动暂停、复盘连续失败。最近的运行从新到旧。 */
export function buildNotices(i: {
  availability: AvailabilityView;
  recentRuns: { status: LessonRunStatus }[];
  routing?: { limited: string[]; fallbacks: number } | null;
}): NowNotice[] {
  const { current, retryAt, lessonsPause } = i.availability;
  const out: NowNotice[] = [];
  if (current !== null) {
    if (i.availability.state === "model_unavailable") out.push({ kind: "model_unavailable", hit: current, retryAt });
    else if (i.availability.state === "limited") out.push({ kind: "claude_limited", hit: current, retryAt, lessonsPaused: lessonsPause?.reason === "limit" });
  }
  if (i.routing) out.push({ kind: "routing", limited: i.routing.limited, fallbacks: i.routing.fallbacks });
  if (lessonsPause?.reason === "manual") out.push({ kind: "lessons_paused" });
  let failed = 0;
  for (const r of i.recentRuns) {
    if (NEUTRAL.has(r.status)) continue;
    if (r.status !== "failed") break;
    failed++;
  }
  if (failed >= LESSONS_FAILING_MIN) out.push({ kind: "lessons_failing", count: failed });
  return out;
}

/** 递不出去的 CI 结论（工作流 W）：每条一个提醒，点开去 ticket（有要递给的 session 就打开它）。 */
export function ciNotices(list: CiUndelivered[], title: (ticketKey: string) => string | null): NowNotice[] {
  return list.map((ci) => ({ kind: "ci_undelivered" as const, ci, title: title(ci.ticketKey), target: { page: "ticket" as const, key: ci.ticketKey, sessionId: ci.sessionId } }));
}
