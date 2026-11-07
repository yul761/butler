import { useEffect, useState } from "react";
import type { RefreshRefusal } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";

/** 换新开始不了时，原因在按钮上显示这么久。 */
const REFUSED_MS = 4000;

/**
 * session 按钮旁边的 ↻，给正在运行的终端用（计划 16）：让 Butler 给这个 session 换新上下文（handoff → 清空 → 从记忆里接上）。
 * Butler 马上回答：开始了就在后台跑，终端里能看到；开始不了就在按钮上短暂显示原因。
 */
export function RefreshSessionButton({ sessionId, label }: { sessionId: string; label: string }) {
  const [refused, setRefused] = useState<RefreshRefusal | null>(null);

  useEffect(() => {
    if (!refused) return;
    const t = setTimeout(() => setRefused(null), REFUSED_MS);
    return () => clearTimeout(t);
  }, [refused]);

  function click() {
    setRefused(null);
    api.refreshSession(sessionId).then((r) => {
      if (!r.ok) setRefused(r.reason);
    }, reportError);
  }

  return (
    <button className={refused ? "session-hide armed" : "session-hide"} title={refused ? S.refreshRefused[refused] : S.refreshSession} aria-label={S.refreshSessionNamed(label)} onClick={click}>
      {refused ? S.refreshRefused[refused] : "↻"}
    </button>
  );
}
