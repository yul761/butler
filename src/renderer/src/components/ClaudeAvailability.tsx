import { useEffect, useRef } from "react";
import { api } from "../api";
import { availabilityButtons, availabilityRows } from "../availability-view";
import { reportError } from "../errors";
import { TONE_PILL } from "../lesson-runs-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";
import type { AvailabilityAction } from "../../../shared/availability";

/** 设置 → 健康：Claude 现在能不能用、复盘队列是否暂停，以及恢复／暂停按钮。 */
/** 跳来之后，内容还在长高时继续滚到这一块的时间。 */
const SCROLL_SETTLE_MS = 2000;

export function ClaudeAvailability({ scrollIntoView = false }: { scrollIntoView?: boolean }) {
  const view = useStateRefetch("availability", api.availability);
  // 从首页的提醒跳来：内容出现后滚到这里，只滚一次。
  const scrolled = useRef(false);
  const ready = view !== null && view !== undefined;
  useEffect(() => {
    if (!scrollIntoView || !ready || scrolled.current) return;
    scrolled.current = true;
    const el = document.getElementById("claude-availability");
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    // 下面几块（常规、计划、隐私）可能还在加载，页面这时还滚不动：内容长高时再滚一次，最多等一会儿；用户自己滚了就停。
    const page = el.closest(".page");
    if (!page || typeof ResizeObserver === "undefined") return;
    let stop = false;
    const ro = new ResizeObserver(() => {
      if (!stop) el.scrollIntoView({ block: "start" });
    });
    for (const c of Array.from(page.children)) ro.observe(c);
    const end = () => {
      stop = true;
      ro.disconnect();
    };
    const timer = setTimeout(end, SCROLL_SETTLE_MS);
    page.addEventListener("wheel", end, { once: true, passive: true });
    return () => {
      clearTimeout(timer);
      page.removeEventListener("wheel", end);
      end();
    };
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
