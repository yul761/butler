import { useState } from "react";
import type { LessonFilter } from "../../../shared/lesson-filter";
import { LESSON_ADMISSIONS, LESSON_BULK_VERBS, LESSON_CHECKABILITIES, type Lesson, type LessonActResult, type LessonAction, type LessonBulkVerb } from "../../../shared/lessons";
import { api } from "../api";
import { reportError } from "../errors";
import { BULK_STATUSES, SHELVED_REASONS, bulkCounts, bulkFilter, EMPTY_BULK_FILTER, needsSecondClick, verbFilter, type BulkFilterUi, type LessonTag, type TagTone } from "../lessons-bulk-view";
import { S } from "../strings";

export const TAG_PILL: Record<TagTone, string> = { ok: "approved", warn: "pending", info: "merged", none: "none" };

export function LessonTags({ tags }: { tags: LessonTag[] }) {
  if (!tags.length) return null;
  return (
    <span className="lesson-tags">
      {tags.map((t) => (
        <span key={t.key} className={`pill ${TAG_PILL[t.tone]}`} title={t.title} data-testid={`lesson-tag-${t.key}`}>{t.text}</span>
      ))}
    </span>
  );
}

/** 一个批次做完之后的提示条：说做了什么，可以整批撤销。 */
export interface BatchNoticeState {
  batchId: number | null;
  text: string;
  /** 撤销之后换成撤销的结果，不再给撤销按钮。 */
  undone?: boolean;
}

/** 发一个批量动作，把结果变成提示条。失败时返回原因。 */
export async function runBatch(a: LessonAction, kind: string, onNotice: (n: BatchNoticeState) => void): Promise<string | null> {
  let r: LessonActResult;
  try {
    r = await api.lessonsAct(a);
  } catch (e) {
    reportError(e);
    return null;
  }
  if (!r.ok) return S.lessonsError[r.reason] ?? S.lessonsErrorGeneric;
  const affected = r.affected ?? 0;
  const skipped = r.skipped ?? 0;
  if (!affected) onNotice({ batchId: null, text: S.bulkNothing });
  else onNotice({ batchId: r.batchId ?? null, text: `${(S.bulkDone[kind] ?? S.bulkDone.confirm)(affected)}${skipped ? S.bulkSkipped(skipped) : ""}` });
  return null;
}

export function BatchNotice({ notice, onChange }: { notice: BatchNoticeState; onChange(n: BatchNoticeState | null): void }) {
  const [error, setError] = useState<string | null>(null);
  const undo = async () => {
    if (notice.batchId === null) return;
    try {
      const r = await api.lessonsAct({ op: "undoBatch", batchId: notice.batchId });
      if (!r.ok) return setError(S.batchError[r.reason] ?? S.lessonsErrorGeneric);
      setError(null);
      onChange({ batchId: null, text: S.bulkUndone(r.affected ?? 0, r.skipped ?? 0), undone: true });
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <div className="lessons-notice lessons-row" role="status" data-testid="lessons-notice">
      <span data-testid="lessons-notice-text">{notice.text}</span>
      {notice.batchId !== null && !notice.undone && <button data-testid="lessons-notice-undo" onClick={() => void undo()}>{S.bulkUndo}</button>}
      <button className="link" data-testid="lessons-notice-dismiss" onClick={() => onChange(null)}>{S.bulkDismiss}</button>
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}

function MultiPick<T extends string>({ label, all, value, names, testid, onChange }: {
  label: string; all: readonly T[]; value: T[]; names: Record<T, string>; testid: string; onChange(v: T[]): void;
}) {
  return (
    <fieldset className="bulk-pick" data-testid={testid}>
      <legend>{label}</legend>
      {all.map((x) => (
        <label key={x} className="inline">
          <input type="checkbox" data-testid={`${testid}-${x}`} checked={value.includes(x)} onChange={() => onChange(value.includes(x) ? value.filter((y) => y !== x) : [...value, x])} />
          {names[x]}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * 按筛选批量操作（契约 4.4）：范围是左边选中的仓库 / 产品（或者全部），加上状态、准入、可检查性等条件。
 * 每个按钮上的数字是真正会改的条数；什么条件都没给、或者是删除时，要点第二次才执行。
 */
export function LessonBulkBar({ lessons, base, scopeLabel, onNotice }: {
  lessons: Lesson[]; base: LessonFilter; scopeLabel: string | null; onNotice(n: BatchNoticeState): void;
}) {
  const [ui, setUi] = useState<BulkFilterUi>(EMPTY_BULK_FILTER);
  const [armed, setArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const f = bulkFilter(base, ui);
  const counts = bulkCounts(lessons, f);
  const edit = (patch: Partial<BulkFilterUi>) => {
    setUi((u) => ({ ...u, ...patch }));
    setArmed(null);
  };

  const fire = async (key: LessonBulkVerb | "accept_recommended") => {
    if (needsSecondClick(key, f) && armed !== key) return setArmed(key);
    setArmed(null);
    setBusy(true);
    try {
      const a: LessonAction = key === "accept_recommended" ? { op: "acceptRecommended", target: { filter: f } } : { op: "bulk", verb: key, target: { filter: verbFilter(key, f) } };
      setError(await runBatch(a, key, onNotice));
    } finally {
      setBusy(false);
    }
  };

  const button = (key: LessonBulkVerb | "accept_recommended", n: number, label: string, extra?: { primary?: boolean; title?: string }) => (
    <button
      key={key}
      className={armed === key ? "danger" : extra?.primary ? "primary" : undefined}
      title={extra?.title}
      disabled={busy || n === 0}
      data-testid={`bulk-${key}`}
      onClick={() => void fire(key)}
    >
      {armed === key ? S.bulkArmed(label) : label}
    </button>
  );

  return (
    <section className="lessons-bulk" data-testid="lessons-bulk">
      <h3>{S.bulkTitle}</h3>
      <p className="muted">{scopeLabel ? S.bulkScope(scopeLabel) : S.bulkScopeAll} · <span data-testid="bulk-matched">{S.bulkMatched(counts.matched)}</span></p>
      <div className="lessons-row bulk-filters">
        <MultiPick label={S.bulkFilterStatus} all={BULK_STATUSES} value={ui.status} names={S.lessonStatusLabel} testid="bulk-status" onChange={(status) => edit({ status })} />
        <MultiPick label={S.bulkFilterAdmission} all={LESSON_ADMISSIONS} value={ui.admission} names={S.admissionLabel} testid="bulk-admission" onChange={(admission) => edit({ admission })} />
        <MultiPick
          label={S.bulkFilterCheckability}
          all={[...LESSON_CHECKABILITIES, "unclassified"] as const}
          value={ui.checkability}
          names={S.checkabilityLabel}
          testid="bulk-checkability"
          onChange={(checkability) => edit({ checkability })}
        />
        <MultiPick
          label={S.bulkFilterShelved}
          all={SHELVED_REASONS}
          value={ui.shelvedReason as (typeof SHELVED_REASONS)[number][]}
          names={S.shelvedReasonLabel as Record<(typeof SHELVED_REASONS)[number], string>}
          testid="bulk-shelved"
          onChange={(shelvedReason) => edit({ shelvedReason })}
        />
      </div>
      <div className="lessons-row bulk-filters">
        <input aria-label={S.bulkFilterText} placeholder={S.bulkFilterText} data-testid="bulk-text" value={ui.text} onChange={(e) => edit({ text: e.target.value })} />
        <input aria-label={S.bulkFilterMinScore} placeholder={S.bulkFilterMinScore} inputMode="decimal" className="bulk-score" data-testid="bulk-min-score" value={ui.minScore} onChange={(e) => edit({ minScore: e.target.value })} />
        <input aria-label={S.bulkFilterMaxScore} placeholder={S.bulkFilterMaxScore} inputMode="decimal" className="bulk-score" data-testid="bulk-max-score" value={ui.maxScore} onChange={(e) => edit({ maxScore: e.target.value })} />
        <input aria-label={S.bulkFilterMinHits} placeholder={S.bulkFilterMinHits} inputMode="numeric" className="bulk-score" data-testid="bulk-min-hits" value={ui.minHits} onChange={(e) => edit({ minHits: e.target.value })} />
        <input aria-label={S.bulkFilterBatch} placeholder={S.bulkFilterBatch} inputMode="numeric" className="bulk-score" data-testid="bulk-batch" value={ui.batchId} onChange={(e) => edit({ batchId: e.target.value })} />
        <label className="inline">
          <input type="checkbox" data-testid="bulk-degraded" checked={ui.degradedOnly} onChange={(e) => edit({ degradedOnly: e.target.checked })} />
          {S.bulkFilterDegraded}
        </label>
        <button className="link" data-testid="bulk-clear" onClick={() => edit(EMPTY_BULK_FILTER)}>{S.bulkFilterClear}</button>
      </div>
      <div className="lessons-row">
        {button("accept_recommended", counts.recommended, S.bulkAcceptRecommended(counts.recommended), { primary: true, title: S.bulkAcceptRecommendedTitle })}
        {LESSON_BULK_VERBS.map((v) => button(v, counts.verbs[v], S.bulkVerb[v](counts.verbs[v])))}
      </div>
      {error && <p className="error lessons-error" role="alert">{error}</p>}
    </section>
  );
}
