import { useEffect, useState } from "react";
import type { UiStrings } from "../strings";

const MINUTE = 60_000;

/** 时长：不到 1 分钟是“刚刚”，其余按分钟和小时。 */
export function formatDuration(ms: number, S: UiStrings): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return S.durationNow;
  return minutes < 60 ? S.durationMinutes(minutes) : S.durationHours(Math.floor(minutes / 60), minutes % 60);
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
