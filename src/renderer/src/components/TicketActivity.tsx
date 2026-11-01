import { useEffect, useState } from "react";
import type { SessionActivity } from "../../../shared/activity";
import type { UiStrings } from "../strings";

const MINUTE = 60_000;

/** 时长：不到 1 分钟是“刚刚”，其余按分钟和小时。 */
export function formatDuration(ms: number, S: UiStrings): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return S.durationNow;
  return minutes < 60 ? S.durationMinutes(minutes) : S.durationHours(Math.floor(minutes / 60), minutes % 60);
}

/**
 * 状态列的文字（设计文档 2026-10-31）：main 是一行活动，sub 是文件名或命令加时长；
 * 后台命令在 main 前加“后台”，卡住时 sub 里加上多久没有新输出。
 */
export function activityText(a: SessionActivity, S: UiStrings, now: number): { main: string; sub: string | null } {
  const since = a.startedAt === null ? null : formatDuration(now - a.startedAt, S);
  let main = S.activity[a.kind];
  let sub: string | null;
  if (a.kind === "waiting") sub = since === null ? null : S.activityStoppedAgo(since);
  else if (a.kind === "edit" || a.kind === "read") sub = [a.detail, since].filter(Boolean).join(" · ") || null;
  else if (a.kind === "approval" || a.kind === "thinking") sub = since;
  else sub = [a.kind === "command" || a.kind === "ci" || a.kind === "test" ? a.detail : null, since].filter(Boolean).join(" · ") || null;
  if (a.background) main = S.activityBackground(main);
  if (a.stuck === true) {
    const quiet = a.lastOutputAt ?? a.startedAt;
    if (quiet !== null) {
      const silent = S.activitySilent(formatDuration(Math.max(MINUTE, now - quiet), S));
      sub = sub ? `${sub} · ${silent}` : silent;
    }
  }
  return { main, sub };
}

/** 每隔一段时间重新取当前时间，让“N 分钟”自己往前走。 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
