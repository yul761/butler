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

/**
 * ActivityMonitor 的 onTurnEnd：记成在等输入；真的改了就先发 data，再按停下处理。
 * waiting 存在库里，ActivityMonitor 随后发的 activity 不作废 tickets.all（diag/view-scopes），
 * 不发 data 的话界面重取拿到的还是「在干活」，之后没有别的 notify 就一直不变（BTL-265 review）。
 */
export function onTurnEndedWithoutStop(
  d: { sessions: Pick<SessionsRepo, "head" | "setWaiting">; notify(scope: "data"): void; stopped(id: string): void },
  headId: string,
  at: number,
): void {
  if (!markTurnEndedWithoutStop(d.sessions, headId, at)) return;
  d.notify("data");
  d.stopped(headId);
}
