// 规矩怎么送进 session（BTL-274）：每个仓库单独开 session 时各种送法的条数；装不下时合并相似规矩、转成检查的入口。
// 放在规矩页的默认视图里（待确认列表下面）。
import { useState } from "react";
import type { Lesson, LessonAction, LessonsState } from "../../../shared/lessons";
import { checkableLessons, deliveryRows, mergeLessonCount, proposalLabel, proposalMembers } from "../lessons-delivery-view";
import { S } from "../strings";

export interface LessonDeliveryProps {
  s: Pick<LessonsState, "repos" | "lessons" | "products" | "mergeProposals" | "mergeRunning" | "mergeFailed">;
  act: (key: string, a: LessonAction) => Promise<boolean>;
  error: (key: string) => string | undefined;
  /** 「做成检查」：和已确认规矩上的同一个按钮（起草、交给检查标签页）。 */
  makeCheck: (l: Lesson) => void;
  drafting: number | null;
  /** 起草后模型说只能写成文字时的说明。 */
  note: (id: number) => string | undefined;
}

export function LessonDelivery({ s, act, error, makeCheck, drafting, note }: LessonDeliveryProps) {
  const [open, setOpen] = useState<"merge" | "check" | null>(null);
  const rows = deliveryRows(s);
  if (rows.length === 0) return null;
  const tight = rows.some((r) => r.overBudget);
  const merges = mergeLessonCount(s);
  const checkable = checkableLessons(s);
  const err = (key: string) => {
    const m = error(key);
    return m ? <p className="error lessons-error" role="alert">{m}</p> : null;
  };
  return (
    <section className="lessons-delivery" data-testid="lessons-delivery">
      <h3>{S.lessonsDeliveryTitle}</h3>
      <ul className="lessons-delivery-rows">
        {rows.map((r) => (
          <li key={r.slug} data-testid={`lessons-delivery-${r.slug}`}>
            <strong>{r.slug}</strong> <span className="muted">{S.lessonsDeliveryLine(r.counts)}</span>
          </li>
        ))}
      </ul>
      {tight && <p className="muted" data-testid="lessons-over-budget">{S.lessonsOverBudgetHint}</p>}
      <div className="lessons-row">
        {merges > 0 ? (
          <button className={open === "merge" ? "primary" : undefined} data-testid="lessons-merge-similar" onClick={() => setOpen(open === "merge" ? null : "merge")}>
            {S.lessonsMergeSimilar(merges)}
          </button>
        ) : null}
        {s.mergeRunning ? (
          <span className="pill" data-testid="lessons-merge-running">{S.lessonsMergeRunning}</span>
        ) : (
          <button data-testid="lessons-merge-find" onClick={() => void act("merge-find", { op: "suggestMerges" })}>{S.lessonsMergeFind}</button>
        )}
        {checkable.length > 0 && (
          <button className={open === "check" ? "primary" : undefined} data-testid="lessons-to-check" onClick={() => setOpen(open === "check" ? null : "check")}>
            {S.lessonsToCheck(checkable.length)}
          </button>
        )}
      </div>
      {s.mergeFailed > 0 && !s.mergeRunning && <p className="muted" data-testid="lessons-merge-failed">{S.lessonsMergeFailed(s.mergeFailed)}</p>}
      {err("merge-find")}
      {/* 接受 / 不合并失败（比如建议作废了）时那一条已经不在列表里：错误放在列表外面，不跟着消失。 */}
      {err("merge-proposal")}
      {open === "merge" && (
        <div className="lessons-merge-proposals">
          {s.mergeProposals.length === 0 && <p className="muted">{S.lessonsMergeNone}</p>}
          {s.mergeProposals.map((p) => {
            const key = "merge-proposal";
            return (
              <div key={p.id} className="lesson" data-testid={`lessons-merge-proposal-${p.id}`}>
                <p className="muted">
                  {S.lessonsMergeProposal(p.ids.length, proposalLabel(p, s))}
                  {p.reason === "over_budget" && <span className="pill none">{S.lessonsMergeReasonOverBudget}</span>}
                </p>
                <ul className="muted">
                  {proposalMembers(p, s).map((l) => <li key={l.id}>#{l.id} {l.text}</li>)}
                </ul>
                <p className="lesson-text">→ {p.text}</p>
                {p.why && <p className="muted">{S.lessonsWhy(p.why)}</p>}
                <div className="lessons-row">
                  <button className="primary" data-testid={`lessons-merge-accept-${p.id}`} onClick={() => void act(key, { op: "acceptMerge", id: p.id })}>{S.lessonsMergeAccept}</button>
                  <button data-testid={`lessons-merge-dismiss-${p.id}`} onClick={() => void act(key, { op: "dismissMerge", id: p.id })}>{S.lessonsMergeDismiss}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {open === "check" && (
        <div className="lessons-to-check-list">
          <p className="muted">{S.lessonsToCheckHint}</p>
          {checkable.map((l) => (
            <div key={l.id} data-testid={`lessons-to-check-${l.id}`}>
              <div className="lessons-row">
                <span className="lesson-text">{l.text}</span>
                <button disabled={drafting !== null} data-testid={`lessons-to-check-make-${l.id}`} onClick={() => makeCheck(l)}>
                  {drafting === l.id ? S.lessonDrafting : S.lessonMakeCheck}
                </button>
              </div>
              {note(l.id) && <p className="muted">{note(l.id)}</p>}
              {err(`lesson-${l.id}`)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
