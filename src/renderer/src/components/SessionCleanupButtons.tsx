import { useEffect, useState } from "react";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";

/** 结果（关了几个、删了几个）在按钮上显示这么久；第一次点「全部删除」之后这么久没点第二次就恢复。 */
const NOTE_MS = 4000;

/** 过一会儿自己清掉的状态。 */
function useBrief<T>(): [T | null, (v: T | null) => void] {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => {
    if (v === null) return;
    const t = setTimeout(() => setV(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [v]);
  return [v, setV];
}

/**
 * session 栏里的「清理闲置」（BTL-190 第 8 点）：这一栏开着终端的 session 里，停下来一阵、没有要你决定的事的，
 * 让 Butler 先写 handoff 再结束终端并隐藏（之后能恢复）。Butler 马上回答开始关了几个，关闭在后台跑。
 */
export function CloseIdleButton({ sessionIds }: { sessionIds: string[] }) {
  const [started, setStarted] = useBrief<number>();
  if (sessionIds.length === 0) return null;

  function click() {
    setStarted(null);
    api.closeIdleSessions(sessionIds).then(setStarted, reportError);
  }

  return (
    <button className="session more" title={S.closeIdleHint} onClick={click}>
      {started === null ? S.closeIdle : S.closeIdleStarted(started)}
    </button>
  );
}

/** 隐藏列表里的「全部删除」（BTL-190 第 8 点）：点两次，删掉这些 session 行；对话记录（transcript）留着。 */
export function DeleteHiddenButton({ sessionIds }: { sessionIds: string[] }) {
  const [armed, setArmed] = useBrief<true>();

  function click() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(null);
    api.deleteHiddenSessions(sessionIds).catch(reportError);
  }

  return (
    <button className={armed ? "armed" : undefined} title={S.deleteHiddenHint} onClick={click}>
      {armed ? S.deleteHiddenConfirm(sessionIds.length) : S.deleteHidden}
    </button>
  );
}
