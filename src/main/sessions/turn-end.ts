import type { SessionsRepo } from "../db/sessions-repo";

/**
 * transcript 显示 head 这一轮没经过 Stop hook 就结束了（Esc 打断、API / 限额错误）：记成在等输入，返回是否真的改了。
 * 已经在等、head 换了、或者 at 之后已经有输入（UserPromptSubmit 把 lastActivityAt 推到了 at 之后）就不动。
 */
export function markTurnEndedWithoutStop(sessions: Pick<SessionsRepo, "head" | "setWaiting">, headId: string, at: number): boolean {
  const head = sessions.head(headId);
  if (!head || head.id !== headId || head.waitingForInput || (head.lastActivityAt ?? 0) > at) return false;
  sessions.setWaiting(headId, true, at);
  return true;
}
