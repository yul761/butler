// ticket 的「状态」（BTL-244）：最新一份 handoff 就是这个 ticket 现在的状态。概况里显示最新一份并能更新，「记录」里列出全部历史。
// 界面上不再出现 handoff 这个概念；/handoff 命令照旧。
import type { HandoffRecord } from "../../../shared/types";
import { triggerLabel } from "../followup-view";
import { S } from "../strings";

export function formatStatusTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <span className="muted">{title}</span>
      <ul className="day-list">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

/** 一份状态：时间、来源、完成、下一步、阻塞、待确认；没通过校验的显示原文。 */
export function StatusEntry({ h }: { h: HandoffRecord }) {
  return (
    <div className="handoff-entry">
      <div>
        <strong>{formatStatusTime(h.createdAt)}</strong> <span className="muted">{triggerLabel(h.trigger)}</span>
        {h.degraded && <span className="error"> {S.degradedBadge}</span>}
      </div>
      {h.payload ? (
        <>
          <Section title={S.doneToday} items={h.payload.done_today} />
          <Section title={S.nextSteps} items={h.payload.next_steps} />
          <Section title={S.blockers} items={h.payload.blockers} />
          <Section title={S.openQuestions} items={h.payload.open_questions} />
        </>
      ) : (
        <pre className="raw">{h.rawText ?? ""}</pre>
      )}
    </div>
  );
}

export interface TicketStatusProps {
  /** 还没取到为 undefined；一份都没有为 null。 */
  latest: HandoffRecord | null | undefined;
  running: boolean;
  /** 上一次「更新状态」的结果。 */
  message: string | null;
  onRun: () => void;
}

/** 概况里的「状态」一节：最新一份，加一个「更新状态」按钮（原来的「立即 handoff」）。 */
export function TicketStatus({ latest, running, message, onRun }: TicketStatusProps) {
  return (
    <section className="ticket-home-status" data-testid="ticket-status">
      <h3>
        {S.lay.homeStatus}
        <button disabled={running} onClick={onRun}>{running ? S.handoffRunning : S.runHandoff}</button>
      </h3>
      {message && <p className="muted" role="status">{message}</p>}
      {latest === null && <p className="muted">{S.noHandoffs}</p>}
      {latest && <StatusEntry h={latest} />}
    </section>
  );
}
