import type { LessonActResult, LessonFinding, LessonQueueRowStatus, LessonRunDetail, LessonQueueRowView, LessonQueueView, LessonRunSummary, LessonScope, LessonSource } from "../../shared/lessons";
import { resetClock } from "./availability-view";
import { formatDuration } from "./components/TicketActivity";
import type { UiStrings } from "./strings";

export type Tone = "ok" | "warn" | "danger" | "muted";

/** 语气对应的现有 pill 样式（不新增颜色）。 */
export const TONE_PILL: Record<Tone, string> = { ok: "approved", warn: "pending", danger: "changes", muted: "none" };

/** 队列条上的一行字：正在分析谁、队列多长、是否暂停（到几点）。 */
export function queueBarText(q: LessonQueueView, S: UiStrings, now: number): { text: string; tone: Tone } {
  const parts: string[] = [];
  if (q.running.length > 0) parts.push(S.lessonQueueRunning(q.running.map((r) => `${r.slug}#${r.prNumber}`).join(S.lessonQueueSep)));
  if (q.queued > 0) parts.push(S.lessonQueueQueued(q.queued));
  if (q.pause) {
    if (q.pause.reason === "manual") parts.push(S.lessonQueuePausedManual);
    else parts.push(S.lessonQueuePausedUntil(q.pause.until === null ? "—" : resetClock(q.pause.until, now), q.pause.message));
  } else if (parts.length === 0) parts.push(S.lessonQueueIdle);
  const tone: Tone = q.pause ? (q.pause.reason === "manual" ? "muted" : "warn") : q.running.length > 0 ? "ok" : "muted";
  return { text: parts.join(" · "), tone };
}

/** 队列条的按钮：暂停中显示“恢复”，否则“暂停”；暂停或有排队时可以“立即运行”。 */
export function queueBarButtons(q: LessonQueueView): { toggle: "pause" | "resume"; runNow: boolean } {
  return { toggle: q.pause ? "resume" : "pause", runNow: q.pause !== null || q.queued > 0 };
}

/** 一行的状态标签：分析中带已用时间；失败 danger、受限 warn、完成 ok，其余 muted。 */
export function runStatusPill(r: LessonQueueRowView, S: UiStrings, now: number): { text: string; tone: Tone } {
  const label = S.lessonRunStatus[r.status];
  if (r.status === "running") return { text: `${label} · ${formatDuration(now - (r.lastRun?.startedAt ?? r.enqueuedAt), S)}`, tone: "muted" };
  const tone: Tone = r.status === "failed" ? "danger" : r.status === "limited" ? "warn" : r.status === "done" ? "ok" : "muted";
  return { text: label, tone };
}

/** 有行在分析时，Runs 标签页每隔这么久重画一次，让已用时间往前走。 */
export const RUNNING_TICK_MS = 30_000;

/** 有行在分析时每 RUNNING_TICK_MS 调一次 tick；没有就不设定时器。返回清理函数（卸载或行变了时调）。 */
export function runningTicker(rows: Pick<LessonQueueRowView, "status">[], tick: () => void, ms = RUNNING_TICK_MS): () => void {
  if (!rows.some((r) => r.status === "running")) return () => {};
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
}

/** 一行操作失败的文字：先用分析记录自己的措辞，没有的再用规矩页的。 */
export function runErrorText(code: string, S: UiStrings): string {
  const own: Record<string, string> = S.lessonRunError;
  const shared: Record<string, string> = S.lessonsError;
  return (Object.hasOwn(own, code) ? own[code] : undefined) ?? (Object.hasOwn(shared, code) ? shared[code] : undefined) ?? S.lessonsErrorGeneric;
}

/** 原因的文字；不认识的代码原样显示。 */
export function reasonText(reason: string | null, S: UiStrings): string | null {
  if (reason === null) return null;
  const table: Record<string, string> = S.lessonRunReason;
  return Object.hasOwn(table, reason) ? table[reason] : reason;
}

export function runCountsText(s: Pick<LessonRunSummary, "created" | "hit" | "dropped">, S: UiStrings): string {
  return S.lessonRunCounts(s.created, s.hit, s.dropped);
}

/** 规矩的出处：产品的规矩要写明仓库（slug#N），仓库的规矩只写 #N。 */
export function sourceLabel(src: Pick<LessonSource, "prNumber" | "slug">, scope: LessonScope): string {
  return scope.kind === "product" && src.slug ? `${src.slug}#${src.prNumber}` : `#${src.prNumber}`;
}

/** 一行上的按钮：重试（失败、跳过、已取消、受限），取消（排队、等待、受限、分析中）。 */
export function rowButtons(status: LessonQueueRowStatus): Array<"retry" | "cancel"> {
  const out: Array<"retry" | "cancel"> = [];
  if (status === "failed" || status === "skipped" || status === "cancelled" || status === "limited") out.push("retry");
  if (status === "queued" || status === "waiting" || status === "limited" || status === "running") out.push("cancel");
  return out;
}

/** 表头“重试全部失败”显示的数量；0 就不显示。 */
export function retryAllCount(rows: LessonQueueRowView[]): number {
  return rows.filter((r) => r.status === "failed").length;
}

/** 还没开始过的行（没有运行）没有详情可看。 */
export function runSelectable(r: LessonQueueRowView): boolean {
  return r.lastRun !== null;
}

export const timeText = (ms: number) => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 详情里的“状态 / 开始 / 用时 / 模型 / 费用 / token / 第几次”；没有值的省略。 */
export function runDetailFacts(d: LessonRunDetail, S: UiStrings): [label: string, value: string][] {
  const F = S.lessonRunFact;
  const label = S.lessonRunStatus[d.status === "aborted" ? "failed" : d.status];
  const reason = reasonText(d.reason, S);
  const earlier = d.attempts.filter((a) => a.id < d.id).length;
  const facts: [string, string | null][] = [
    [F.status, reason ? `${label} · ${reason}` : label],
    [F.started, timeText(d.startedAt)],
    [F.duration, d.durationMs === null ? null : formatDuration(d.durationMs, S)],
    [F.model, d.model],
    [F.cost, d.costUsd === null ? null : `$${d.costUsd.toFixed(4)}`],
    [F.tokens, d.inputTokens === null || d.outputTokens === null ? null : `${d.inputTokens} / ${d.outputTokens}`],
    [F.attempt, `${earlier + 1} / ${d.attempts.length + 1}`],
  ];
  return facts.filter((f): f is [string, string] => f[1] !== null);
}

/**
 * 详情里哪些段落要显示。
 * findings 为 null 时分不出“被截断”还是“格式不对”，所以只是不显示这一段；
 * 材料和原始输出被清理后（trimmed）显示一句说明代替。
 */
export function detailSections(d: LessonRunDetail): {
  message: string | null;
  stderr: string | null;
  ghStderr: string | null;
  lessons: boolean;
  dropped: boolean;
  findings: LessonFinding[] | null;
  material: string | null;
  rawOutput: string | null;
  trimmedNote: boolean;
  attempts: boolean;
} {
  const text = (v: string | null) => (v && v.trim() ? v : null);
  return {
    message: text(d.message),
    stderr: text(d.stderrTail),
    ghStderr: text(d.ghStderr),
    lessons: d.lessons.length > 0,
    dropped: d.dropped > 0,
    findings: d.findings && d.findings.length > 0 ? d.findings : null,
    material: text(d.material),
    rawOutput: text(d.rawOutput),
    trimmedNote: d.trimmed,
    attempts: d.attempts.length > 0,
  };
}

/** 详情里的按钮：重试/取消只给这个 PR 最近一次运行（有队列项）；总能在 Claude 里打开（清理过的运行文件里会写明材料已清理）。 */
export function detailButtons(d: LessonRunDetail, queueStatus: LessonQueueRowStatus | null): Array<"retry" | "cancel" | "open"> {
  const out: Array<"retry" | "cancel" | "open"> = queueStatus === null ? [] : rowButtons(queueStatus);
  out.push("open");
  return out;
}

/** “在 Claude 里打开”的结果：成功就跳到那个 session，失败显示原因。 */
export function openInClaudeOutcome(r: LessonActResult, S: UiStrings): { kind: "open"; sessionId: string } | { kind: "error"; text: string } | { kind: "none" } {
  if (!r.ok) return { kind: "error", text: runErrorText(r.reason, S) };
  return r.sessionId ? { kind: "open", sessionId: r.sessionId } : { kind: "none" };
}
