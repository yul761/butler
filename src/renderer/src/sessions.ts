import type { SessionView } from "../../shared/types";

const LABEL_LIMIT = 24;

/** 按钮上显示的名字：这段对话的第一句话（单行、截断），还没说话时用 fallback。 */
export function sessionLabel(s: SessionView, fallback: string): string {
  const text = (s.firstPrompt ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT)}…` : text;
}

/**
 * 默认只露出最近的几个 session；打开着的和等你输入的永远露出，剩下的名额给最近的。
 * sessions 已按最近活动排序，返回值保持原顺序。
 */
export function splitSessions(sessions: SessionView[], limit: number): { shown: SessionView[]; hidden: SessionView[] } {
  const pinned = (s: SessionView) => s.termId !== null || s.waitingForInput;
  let free = Math.max(0, limit - sessions.filter(pinned).length);
  const shown: SessionView[] = [];
  const hidden: SessionView[] = [];
  for (const s of sessions) {
    if (pinned(s)) shown.push(s);
    else if (free > 0) {
      shown.push(s);
      free--;
    } else hidden.push(s);
  }
  return { shown, hidden };
}
