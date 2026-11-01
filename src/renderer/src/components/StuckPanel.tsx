import { useState } from "react";
import type { SessionActivity } from "../../../shared/activity";
import { S } from "../strings";

interface Props {
  activity: SessionActivity;
  /** 为这个卡住的 session 开修复 session；失败时自己报错。 */
  onFix: () => Promise<void>;
  onViewTerminal: () => void;
  onDismiss: () => void;
  onCollapse: () => void;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** 卡住的 ticket 下面展开的面板：可能的原因、最后的输出、要做什么，以及三个按钮（设计文档 2026-10-31）。 */
export function StuckPanel({ activity: a, onFix, onViewTerminal, onDismiss, onCollapse }: Props) {
  const [fixing, setFixing] = useState(false);
  async function fix() {
    setFixing(true);
    try {
      await onFix();
    } finally {
      setFixing(false);
    }
  }
  return (
    <div className="stuck-panel">
      <p>
        <strong>{S.stuckHeading}</strong>
        {a.reason ?? S.stuckNoReason}
      </p>
      {a.lastOutput.length > 0 && (
        <>
          <span className="muted">{a.lastOutputAt ? `${S.stuckLastOutput}（${clock(a.lastOutputAt)}）` : S.stuckLastOutput}</span>
          <pre className="stuck-log">{a.lastOutput.join("\n")}</pre>
        </>
      )}
      {a.action && (
        <p>
          <strong>{S.stuckWhatToDo}</strong>
          {a.action}
        </p>
      )}
      <div className="actions">
        <button className="primary" disabled={fixing} onClick={() => void fix()}>{S.stuckFix}</button>
        <button onClick={onViewTerminal}>{S.stuckViewTerminal}</button>
        <button onClick={onDismiss}>{S.stuckDismiss}</button>
        <button onClick={onCollapse}>{S.collapse}</button>
      </div>
    </div>
  );
}
