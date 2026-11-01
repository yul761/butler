import { useEffect, useRef, useState } from "react";
import type { SessionActivity } from "../../../shared/activity";
import { S } from "../strings";

interface Props {
  activity: SessionActivity;
  /** 为这个卡住的 session 开修复 session；失败时自己报错。 */
  onFix: () => Promise<void>;
  onViewTerminal: () => void;
  onDismiss: () => void;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** 卡住的 ticket 下面展开的面板：可能的原因、最后的输出、要做什么，以及三个按钮（设计文档 2026-10-31）。 */
export function StuckPanel({ activity: a, onFix, onViewTerminal, onDismiss }: Props) {
  const [fixing, setFixing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // 概览区放不下时面板可能在滚动范围外面：不滚过去，点了红点或通知什么也看不到。
  useEffect(() => {
    root.current?.scrollIntoView({ block: "nearest" });
  }, []);
  async function fix() {
    setFixing(true);
    try {
      await onFix();
    } finally {
      setFixing(false);
    }
  }
  return (
    <div className="stuck-panel" ref={root}>
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
      </div>
    </div>
  );
}
