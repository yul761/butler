import { useEffect, useState } from "react";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";

/** 点第一次只是“确认结束？”，这么久没点第二次就恢复成 ×。 */
const CONFIRM_MS = 4000;

/**
 * session 按钮旁边的 ×，给正在运行的终端用（包括总控开的子 session）：点两次结束 claude 进程，并关掉它的终端面板。
 * 对话记录留着，点这个 session 的按钮可以再打开（--resume）。
 */
export function EndSessionButton({ termId, label, onEnded }: { termId: string; label: string; onEnded: () => void }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [armed]);

  function click() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    api.ptyKill(termId).then(onEnded, reportError);
  }

  return (
    <button className={armed ? "session-hide armed" : "session-hide"} title={S.endSession} aria-label={S.endSessionNamed(label)} onClick={click}>
      {armed ? S.endSessionConfirm : "×"}
    </button>
  );
}
