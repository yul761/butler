import { useEffect, useState } from "react";
import type { CheckEffectiveView, CheckInput, CheckScope, CheckStage, ChecksAction, ChecksActResult, ChecksBulkOp, CheckType, CheckVerdict } from "../../../shared/checks";
import { CHECK_TYPES, CHECKS_BULK_OPS } from "../../../shared/checks";
import type { EditableSettingKey } from "../../../shared/settings";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { adoption, checksErrorText, emptyForm, formFromInput, inputFromForm, livePickedChecks, paramsSummary, parseScopeKey, scopeKey, scopeOptions, type CheckForm } from "../checks-view";
import { S } from "../strings";
import type { BatchNoticeState } from "./LessonBulkBar";
import { useStateRefetch } from "./useStateRefetch";
import { CheckRepoTools } from "./CheckRepoTools";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 从规矩起草出来、等用户看过再保存的一条检查。 */
export interface CheckDraftState {
  lessonId: number;
  scope: CheckScope;
  input: CheckInput;
  reason: string;
}

interface Editing {
  id: number | null;
  scope: CheckScope;
  form: CheckForm;
  lessonId: number | null;
  reason: string | null;
}

/** 一条检查的命中记录，带误报 / 确实有问题的标记。 */
function HitList({ checkKey, onError }: { checkKey: string; onError(text: string | null): void }) {
  const hits = useStateRefetch(`check-hits-${checkKey}`, () => api.checksHits(checkKey));
  const verdict = async (hitId: number, v: CheckVerdict | null) => {
    try {
      const r = await api.checksAct({ op: "verdict", hitId, verdict: v });
      onError(r.ok ? null : checksErrorText(r, S));
    } catch (e) {
      reportError(e);
    }
  };
  if (!hits) return null;
  if (hits.length === 0) return <p className="muted">{S.checksHitsEmpty}</p>;
  return (
    <ul className="check-hits" data-testid={`check-hits-${checkKey}`}>
      {hits.map((h) => (
        <li key={h.id} className="check-hit" data-testid={`check-hit-${h.id}`}>
          <div className="lessons-row">
            <span className={`pill ${h.outcome === "fail" ? (h.blocked ? "changes" : "pending") : h.outcome === "resolved" ? "approved" : "none"}`}>{S.checksOutcomeLabel[h.outcome]}</span>
            {h.blocked && <span className="pill changes">{S.checksHitBlocked}</span>}
            {h.mode === "shadow" && <span className="pill none">{S.checksHitShadow}</span>}
            {h.stage === "push" && <span className="pill none">{S.checksHitPush}</span>}
            <code>{h.file}{h.line !== null ? `:${h.line}` : ""}</code>
            {h.repoSlug && <span className="muted">{h.repoSlug}</span>}
            <span className="muted">{formatTime(h.at)}</span>
          </div>
          {h.detail && <pre className="check-hit-detail">{h.detail}</pre>}
          {h.outcome === "fail" && (
            <div className="lessons-row">
              {h.verdict && <span className="muted">{S.checksVerdictLabel[h.verdict]}</span>}
              {h.verdict !== "false_positive" && <button data-testid={`check-hit-fp-${h.id}`} onClick={() => void verdict(h.id, "false_positive")}>{S.checksVerdictFalse}</button>}
              {h.verdict !== "true_positive" && <button data-testid={`check-hit-tp-${h.id}`} onClick={() => void verdict(h.id, "true_positive")}>{S.checksVerdictTrue}</button>}
              {h.verdict && <button className="link" onClick={() => void verdict(h.id, null)}>{S.checksVerdictClear}</button>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

const lines = (v: string, set: (v: string) => void, testid: string, label: string) => (
  <label className="field">
    {label}
    <textarea data-testid={testid} rows={2} value={v} onChange={(e) => set(e.target.value)} />
  </label>
);

/** 新建 / 编辑 / 从规矩起草的一条检查。 */
function CheckFormView({ editing, onChange, onSave, onCancel, error }: { editing: Editing; onChange(f: CheckForm): void; onSave(): void; onCancel(): void; error: string | null }) {
  const f = editing.form;
  const set = <K extends keyof CheckForm>(k: K, v: CheckForm[K]) => onChange({ ...f, [k]: v });
  const title = editing.lessonId !== null ? S.checksFormTitleDraft : editing.id === null ? S.checksFormTitleNew : S.checksFormTitleEdit;
  return (
    <div className="lesson-editor check-form" data-testid="check-form">
      <h3>{title}</h3>
      {editing.reason && <p className="muted" data-testid="check-form-reason">{S.checksFormDraftReason(editing.reason)}</p>}
      <label className="field">
        {S.checksFormName}
        <input data-testid="check-form-name" value={f.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label className="field">
        {S.checksFormType}
        <select data-testid="check-form-type" value={f.type} disabled={editing.id !== null} onChange={(e) => set("type", e.target.value as CheckType)}>
          {CHECK_TYPES.map((t) => <option key={t} value={t}>{S.checksTypeLabel[t]}</option>)}
        </select>
      </label>
      {f.type === "forbidden_pattern" && (
        <>
          <label className="field">
            {S.checksFormPattern}
            <input data-testid="check-form-pattern" value={f.pattern} onChange={(e) => set("pattern", e.target.value)} />
          </label>
          <label className="inline"><input type="checkbox" checked={f.literal} onChange={(e) => set("literal", e.target.checked)} />{S.checksFormLiteral}</label>
          <label className="inline"><input type="checkbox" checked={f.ignoreCase} onChange={(e) => set("ignoreCase", e.target.checked)} />{S.checksFormIgnoreCase}</label>
        </>
      )}
      {f.type === "import_boundary" && (
        <>
          {lines(f.forbid, (v) => set("forbid", v), "check-form-forbid", S.checksFormForbid)}
          {lines(f.allow, (v) => set("allow", v), "check-form-allow", S.checksFormAllow)}
        </>
      )}
      {f.type === "comment_policy" && (
        <>
          {lines(f.keywords, (v) => set("keywords", v), "check-form-keywords", S.checksFormKeywords)}
          <label className="field">
            {S.checksFormTicket}
            <input data-testid="check-form-ticket" value={f.ticketPattern} onChange={(e) => set("ticketPattern", e.target.value)} />
          </label>
        </>
      )}
      {f.type === "run_command" && (
        <>
          <label className="field">
            {S.checksFormCommand}
            <input data-testid="check-form-command" value={f.command} onChange={(e) => set("command", e.target.value)} />
          </label>
          <label className="field">
            {S.checksFormStage}
            <select data-testid="check-form-stage" value={f.stage} onChange={(e) => set("stage", e.target.value as CheckStage)}>
              {(["edit", "push"] as const).map((s) => <option key={s} value={s}>{S.checksStageLabel[s]}</option>)}
            </select>
          </label>
          <label className="field">
            {S.checksFormTimeout}
            <input data-testid="check-form-timeout" inputMode="decimal" value={f.timeoutSec} onChange={(e) => set("timeoutSec", e.target.value)} />
          </label>
        </>
      )}
      {lines(f.globs, (v) => set("globs", v), "check-form-globs", S.checksFormGlobs)}
      {lines(f.excludeGlobs, (v) => set("excludeGlobs", v), "check-form-exclude", S.checksFormExclude)}
      <div className="lessons-row">
        <label className="inline">
          {S.checksFormSeverity}
          <select data-testid="check-form-severity" value={f.severity} onChange={(e) => set("severity", e.target.value as CheckForm["severity"])}>
            {(["block", "warn"] as const).map((s) => <option key={s} value={s}>{S.checksSeverityLabel[s]}</option>)}
          </select>
        </label>
        <label className="inline">
          {S.checksFormMode}
          <select data-testid="check-form-mode" value={f.mode} onChange={(e) => set("mode", e.target.value as CheckForm["mode"])}>
            {(["shadow", "enforce"] as const).map((s) => <option key={s} value={s}>{S.checksModeLabel[s]}</option>)}
          </select>
        </label>
        <label className="inline"><input type="checkbox" data-testid="check-form-enabled" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />{S.checksFormEnabled}</label>
      </div>
      {lines(f.message, (v) => set("message", v), "check-form-message", S.checksFormMessage)}
      {error && <p className="error" role="alert" data-testid="check-form-error">{error}</p>}
      <div className="lessons-row">
        <button className="primary" data-testid="check-form-save" onClick={onSave}>{S.checksFormSave}</button>
        <button onClick={onCancel}>{S.lessonsCancel}</button>
      </div>
    </div>
  );
}

const SETTING_KEYS = ["checksEditTimeoutSec", "checksPushTimeoutSec"] as const satisfies readonly EditableSettingKey[];

/** 检查的三个设置：开关立刻生效，时间失焦时保存。 */
function ChecksSettings({ settings }: { settings: { enabled: boolean; editTimeoutSec: number; pushTimeoutSec: number } }) {
  const [draft, setDraft] = useState<Partial<Record<(typeof SETTING_KEYS)[number], string>>>({});
  const [error, setError] = useState<string | null>(null);
  const current = { checksEditTimeoutSec: String(settings.editTimeoutSec), checksPushTimeoutSec: String(settings.pushTimeoutSec) };
  const save = async (k: EditableSettingKey, v: string) => {
    setError(null);
    try {
      await api.setSetting(k, v);
      setDraft((d) => {
        const next = { ...d };
        delete next[k as (typeof SETTING_KEYS)[number]];
        return next;
      });
    } catch (e) {
      if (e instanceof ButlerError && e.code === "invalid_setting") setError(e.message);
      else reportError(e);
    }
  };
  return (
    <details className="checks-settings" data-testid="checks-settings">
      <summary>{S.checksSettingsTitle}</summary>
      <p className="muted">{S.checksSettingsNote}</p>
      <label className="inline">
        <input type="checkbox" data-testid="setting-checksEnabled" checked={settings.enabled} onChange={(e) => void save("checksEnabled", e.target.checked ? "1" : "0")} />
        {S.checksSettingEnabled}
      </label>
      {SETTING_KEYS.map((k) => (
        <label key={k} className="field">
          {k === "checksEditTimeoutSec" ? S.checksSettingEditTimeout : S.checksSettingPushTimeout}
          <input
            type="number"
            data-testid={`setting-${k}`}
            value={draft[k] ?? current[k]}
            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
            onBlur={() => draft[k] !== undefined && draft[k] !== current[k] && void save(k, draft[k])}
          />
        </label>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
    </details>
  );
}

/** 规矩页的「检查」标签（addendum 第 8 节）：一层的有效检查、命中统计、命中记录、编辑和批量操作。 */
export function ChecksPanel({ draft, onDraftTaken, onNotice }: { draft: CheckDraftState | null; onDraftTaken(): void; onNotice(n: BatchNoticeState): void }) {
  const [layer, setLayer] = useState("global");
  const scope = parseScopeKey(layer);
  const fetched = useStateRefetch(`checks-${layer}`, () => api.checksView(scope));
  // 换层以后、新的一层取回来之前不显示上一层的行。
  const view = fetched && scopeKey(fetched.scope) === layer ? fetched : null;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [openHits, setOpenHits] = useState<string | null>(null);
  const [openTools, setOpenTools] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);

  // 规矩那边起草好了：切到草稿的层，打开表单（保存时带上 lessonId，进试运行）。
  useEffect(() => {
    if (!draft) return;
    setLayer(scopeKey(draft.scope));
    setEditing({ id: null, scope: draft.scope, form: formFromInput({ ...draft.input, mode: "shadow" }), lessonId: draft.lessonId, reason: draft.reason });
    setFormError(null);
    onDraftTaken();
  }, [draft]);

  // 选中的层不在了（产品删了）：回到全局。
  useEffect(() => {
    if (fetched && !scopeOptions(fetched, S).some((o) => o.key === layer)) setLayer("global");
  }, [fetched]);

  const pickLayer = (k: string) => {
    setLayer(k);
    setPicked([]);
    setOpenHits(null);
    setOpenTools(null);
    setArmedDelete(false);
    setError(null);
  };

  const run = async (a: ChecksAction): Promise<ChecksActResult | null> => {
    try {
      const r = await api.checksAct(a);
      setError(r.ok ? null : checksErrorText(r, S));
      return r;
    } catch (e) {
      reportError(e);
      return null;
    }
  };

  const save = async () => {
    if (!editing) return;
    const r = await run({ op: "save", scope: editing.scope, id: editing.id, input: inputFromForm(editing.form), lessonId: editing.lessonId });
    if (!r) return;
    if (!r.ok) {
      setFormError(checksErrorText(r, S));
      setError(null);
      return;
    }
    setEditing(null);
    setFormError(null);
  };

  const bulk = async (verb: ChecksBulkOp) => {
    const ids = view ? livePickedChecks(picked, view) : [];
    if (!ids.length) return;
    if (verb === "delete" && !armedDelete) return setArmedDelete(true);
    setArmedDelete(false);
    const r = await run({ op: "bulk", ids, verb });
    if (!r?.ok) return;
    onNotice({ batchId: r.batchId, text: r.affected ? S.checksDone(r.affected) : S.bulkNothing });
    if (verb === "delete") setPicked([]);
  };

  const row = (c: CheckEffectiveView) => {
    const k = c.check;
    const own = c.own;
    const hitsOpen = openHits === c.key;
    const ad = adoption(c.stats);
    const couldNot = c.stats.timeouts + c.stats.unavailable;
    return (
      <div key={c.key} className={`lesson confirmed check-row${k.enabled ? "" : " disabled"}`} data-testid={`check-${c.key}`}>
        <div className="lessons-row">
          {own && <input type="checkbox" aria-label={k.name || k.key} data-testid={`check-pick-${c.key}`} checked={picked.includes(own.id)} onChange={() => setPicked((p) => (p.includes(own.id) ? p.filter((x) => x !== own.id) : [...p, own.id]))} />}
          <span className="lesson-text">{k.name || S.checksTypeLabel[k.type]}</span>
          <span className="pill none">{S.checksTypeLabel[k.type]}</span>
          <span className={`pill ${k.mode === "enforce" ? "approved" : "none"}`} data-testid={`check-mode-${c.key}`}>{S.checksModeLabel[k.mode]}</span>
          <span className={`pill ${k.severity === "block" ? "changes" : "pending"}`}>{S.checksSeverityLabel[k.severity]}</span>
          {!k.enabled && <span className="pill none">{S.checksOffTag}</span>}
          {!own && <span className="muted">{S.checksInherited(c.originLabel)}</span>}
        </div>
        <p className="muted check-params"><code>{paramsSummary(k.type, k.params, S)}</code>{k.globs.length > 0 && <> · {k.globs.join(", ")}</>}</p>
        {c.lessonText && <p className="muted">{S.checksFromLesson(c.lessonText)}</p>}
        <p className="muted" data-testid={`check-stats-${c.key}`}>
          {S.checksStats(c.stats, ad)}
          {couldNot > 0 && <> · {S.checksCouldNot(c.stats.timeouts, c.stats.unavailable)}</>}
          {c.stats.lastHitAt !== null && <> · {S.checksLastHit(formatTime(c.stats.lastHitAt))}</>}
        </p>
        {c.stats.lastUnavailable && <p className="muted">{S.checksLastUnavailable(c.stats.lastUnavailable.detail)}</p>}
        <div className="lessons-row">
          {own ? (
            <button data-testid={`check-edit-${c.key}`} onClick={() => {
                setEditing({ id: own.id, scope, form: formFromInput(own), lessonId: null, reason: null });
                setFormError(null);
              }}
            >
              {S.checksEdit}
            </button>
          ) : (
            scope.kind !== "global" && <button data-testid={`check-override-${c.key}`} title={S.checksOverrideHint} onClick={() => void run({ op: "override", scope, key: c.key })}>{S.checksOverride}</button>
          )}
          <button data-testid={`check-hits-toggle-${c.key}`} onClick={() => setOpenHits(hitsOpen ? null : c.key)}>{hitsOpen ? S.checksHitsHide : S.checksHitsShow}</button>
          {(view?.repos.length ?? 0) > 0 && <button data-testid={`check-tools-toggle-${c.key}`} onClick={() => setOpenTools(openTools === c.key ? null : c.key)}>{openTools === c.key ? S.legacy.toolsHide : S.legacy.tools}</button>}
        </div>
        {hitsOpen && <HitList checkKey={c.key} onError={setError} />}
        {openTools === c.key && view && <CheckRepoTools checkId={k.id} checkKey={c.key} repos={view.repos} defaultSlug={scope.kind === "repo" ? scope.slug : null} />}
      </div>
    );
  };

  const livePicked = view ? livePickedChecks(picked, view) : [];
  return (
    <div className="checks-panel" data-testid="checks-panel">
      <p className="muted">{S.checksIntro}</p>
      <div className="lessons-row">
        <label className="inline">
          {S.checksLayer}
          <select data-testid="checks-layer" value={layer} onChange={(e) => pickLayer(e.target.value)}>
            {(fetched ? scopeOptions(fetched, S) : [{ key: "global", label: S.checksLayerGlobal }]).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        <button className="primary" data-testid="checks-new" onClick={() => {
            setEditing({ id: null, scope, form: emptyForm(), lessonId: null, reason: null });
            setFormError(null);
          }}
        >
          {S.checksNew}
        </button>
      </div>
      {view && (
        <p className={view.snapshot.error ? "error" : "muted"} data-testid="checks-snapshot">
          {view.snapshot.error ? S.checksSnapshotError(view.snapshot.error) : view.snapshot.writtenAt === null ? S.checksSnapshotNever : S.checksSnapshotAt(formatTime(view.snapshot.writtenAt))}
        </p>
      )}
      {view && <ChecksSettings settings={view.settings} />}
      {editing && <CheckFormView editing={editing} error={formError} onChange={(form) => setEditing({ ...editing, form })} onSave={() => void save()} onCancel={() => setEditing(null)} />}
      {error && <p className="error lessons-error" role="alert">{error}</p>}
      {livePicked.length > 0 && (
        <div className="lessons-row" data-testid="checks-selection">
          <span className="muted">{S.pendingSelected(livePicked.length)}</span>
          {CHECKS_BULK_OPS.map((op) => (
            <button key={op} className={op === "delete" && armedDelete ? "danger" : undefined} data-testid={`checks-bulk-${op}`} onClick={() => void bulk(op)}>
              {op === "delete" && armedDelete ? S.checksDeleteConfirm(livePicked.length) : S.checksBulkLabel[op]}
            </button>
          ))}
        </div>
      )}
      {view && view.checks.length === 0 && <p className="muted">{S.checksEmpty}</p>}
      {view?.checks.map(row)}
    </div>
  );
}
