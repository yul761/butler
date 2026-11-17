import { useEffect, useRef } from "react";
import { api } from "../api";
import { availabilityButtons, availabilityRows } from "../availability-view";
import { reportError } from "../errors";
import { TONE_PILL } from "../lesson-runs-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";
import type { AvailabilityAction } from "../../../shared/availability";

/** 设置 → 健康：Claude 现在能不能用、复盘队列是否暂停，以及恢复／暂停按钮。 */
export function ClaudeAvailability({ scrollIntoView = false }: { scrollIntoView?: boolean }) {
  const view = useStateRefetch("availability", api.availability);
  // 从「现在」页的提醒跳来：内容出现后滚到这里，只滚一次。
  const scrolled = useRef(false);
  const ready = view !== null && view !== undefined;
  useEffect(() => {
    if (!scrollIntoView || !ready || scrolled.current) return;
    scrolled.current = true;
    document.getElementById("claude-availability")?.scrollIntoView({ block: "start" });
  }, [scrollIntoView, ready]);
  if (!view) return null;
  const rows = availabilityRows(view, S, Date.now());
  const { resume, pause } = availabilityButtons(view);
  const act = async (a: AvailabilityAction) => {
    try {
      await api.availabilityAct(a);
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <section id="claude-availability" data-testid="claude-availability">
      <h3>{S.availabilityTitle}</h3>
      <dl className="kv">
        {rows.map(([label, value, tone, pill]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt>{label}</dt>
            <dd>{pill ? <span className={`pill ${TONE_PILL[tone]}`}>{value}</span> : <span style={{ overflowWrap: "anywhere" }}>{value}</span>}</dd>
          </div>
        ))}
      </dl>
      <div className="actions">
        {resume && <button data-testid="availability-resume" onClick={() => void act({ op: "resumeLessons" })}>{S.availabilityResume}</button>}
        {pause && <button data-testid="availability-pause" onClick={() => void act({ op: "pauseLessons" })}>{S.availabilityPause}</button>}
      </div>
    </section>
  );
}
