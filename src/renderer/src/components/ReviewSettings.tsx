import { useCallback, useEffect, useState } from "react";
import { EXTERNAL_ACTION_SETTINGS } from "../../../shared/external";
import { PRE_REVIEW_CONCURRENCY } from "../../../shared/prereview";
import type { PrPolicyKey, PrPolicyOverrides, PrScope, RiskPathClass } from "../../../shared/pr-policy";
import type { EditableSettings } from "../../../shared/settings";
import { api, ShipherdError } from "../api";
import { reportError } from "../errors";
import { policyScopeFromKey, policyScopeKey } from "../policy-view";
import { parsePrInput, pathClassOf, prGroups, prInputValue, prOverridesFromDraft, type PrDraft } from "../review-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const R = () => S.rv;
/** 预审并发数能选的值（设置 preReviewConcurrency）。 */
const CONCURRENCY_OPTIONS = Array.from({ length: PRE_REVIEW_CONCURRENCY.max - PRE_REVIEW_CONCURRENCY.min + 1 }, (_, i) => PRE_REVIEW_CONCURRENCY.min + i);

/** 设置 →「预审和就绪」（工作流 G）：预审总开关、自动贴简报、三层策略。 */
export function ReviewSettings() {
  return (
    <section className="review-settings" data-testid="review-settings">
      <h2>{R().title}</h2>
      <p className="muted">{R().intro}</p>
      <Switches />
      <PrPolicyEditor />
    </section>
  );
}

/** 预审开关和「自动贴简报」（和「常规」→「对外动作」里的是同一个设置）。 */
function Switches() {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const load = useCallback(async () => {
    try {
      setValues(await api.settings());
    } catch (e) {
      reportError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);
  if (!values) return null;
  const current = values;
  const post = EXTERNAL_ACTION_SETTINGS.pr_brief_post;
  const set = async (key: "preReviewEnabled" | "preReviewConcurrency" | typeof post, value: string) => {
    setValues({ ...current, [key]: value });
    try {
      await api.setSetting(key, value);
    } catch (e) {
      reportError(e);
    }
    await load();
  };
  const toggle = (key: "preReviewEnabled" | typeof post, on: boolean) => set(key, on ? "1" : "0");
  return (
    <div className="field" data-testid="review-switches">
      <label className="inline">
        <input type="checkbox" data-testid="review-enabled" checked={current.preReviewEnabled === "1"} onChange={(e) => void toggle("preReviewEnabled", e.target.checked)} />
        {R().enabled}
      </label>
      <p className="muted">{R().enabledHint}</p>
      <label className="inline">
        {S.prq.concurrencyLabel}
        <select
          data-testid="review-concurrency"
          value={current.preReviewConcurrency}
          onChange={(e) => void set("preReviewConcurrency", e.target.value)}
        >
          {CONCURRENCY_OPTIONS.map((n) => <option key={n} value={String(n)}>{n}</option>)}
        </select>
      </label>
      <p className="muted">{S.prq.concurrencyHint}</p>
      <h3>{R().externalTitle}</h3>
      <label className="inline">
        <input type="checkbox" data-testid="review-auto-post" checked={current[post] === "1"} onChange={(e) => void toggle(post, e.target.checked)} />
        {S.externalActions.pr_brief_post.label}
      </label>
      <p className="muted">{R().externalIntro}</p>
    </div>
  );
}

function PrPolicyEditor() {
  const lessons = useStateRefetch("review-layers", api.lessonsState);
  const [scope, setScope] = useState<PrScope>({ kind: "global" });
  const key = policyScopeKey(scope);
  const view = useStateRefetch(`review-policy-${key}`, () => api.prPolicyGet(scope));
  const [draft, setDraft] = useState<PrDraft>({});
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (v: string) => {
    setScope(policyScopeFromKey(v));
    setDraft({});
    setMessage(null);
  };
  const write = async (overrides: PrPolicyOverrides) => {
    setBusy(true);
    try {
      await api.prPolicySet(scope, overrides);
      setDraft({});
      setMessage({ text: S.lp.saved, error: false });
    } catch (e) {
      if (e instanceof ShipherdError) setMessage({ text: e.message, error: true });
      else reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const current = view && policyScopeKey(view.scope) === key ? view : null;
  const save = () => {
    if (!current) return;
    const r = prOverridesFromDraft(current, draft);
    if (!r.ok) return setMessage({ text: S.lp.badValue(R().key[r.badKey as PrPolicyKey] ?? r.badKey), error: true });
    if (!r.changed) return setMessage({ text: S.lp.noChange, error: false });
    void write(r.overrides);
  };
  const shown = (v: unknown): string => (typeof v === "boolean" ? S.lp.bool(v) : Array.isArray(v) ? (v.length ? v.join(", ") : "—") : typeof v === "string" ? (R().option[v] ?? v) : String(v));
  return (
    <div className="field" data-testid="review-policy-editor">
      <label className="inline">
        {S.lp.layer}
        <select data-testid="review-layer" value={key} onChange={(e) => pick(e.target.value)}>
          <option value="global">{S.lp.layerGlobal}</option>
          {(lessons?.products ?? []).map((p) => <option key={`p${p.id}`} value={`product:${p.id}`}>{S.lp.layerProduct(p.name)}</option>)}
          {(lessons?.repos ?? []).map((r) => <option key={`r${r.slug}`} value={`repo:${r.slug}`}>{S.lp.layerRepo(r.slug)}</option>)}
        </select>
      </label>
      {current && (
        <>
          {current.conflicts.length > 0 && (
            <div className="lessons-suggest" role="status" data-testid="review-conflicts">
              <span>{S.lp.conflicts}</span>
              <ul>
                {current.conflicts.map((c) => <li key={c.key}>{S.lp.conflict(c.key, c.products.map((p) => `${p.name} = ${shown(p.value)}`).join(", "))}</li>)}
              </ul>
            </div>
          )}
          {prGroups(current).map((g) => (
            <div key={g.group}>
              <h4 className="policy-group">{R().group[g.group]}</h4>
              {g.group === "risk" && <p className="muted">{R().pathsHint} {R().typesHint}</p>}
              <table className="policy-table">
                <thead>
                  <tr><th>{S.lp.colKey}</th><th>{S.lp.colEffective}</th><th>{S.lp.colFrom}</th><th>{S.lp.colOverride}</th></tr>
                </thead>
                <tbody>
                  {g.keys.map((k) => {
                    const raw = draft[k.key] ?? prInputValue(k.override);
                    const bad = draft[k.key] !== undefined && parsePrInput(k.key, raw) === undefined;
                    const set = (v: string) => setDraft((d) => ({ ...d, [k.key]: v }));
                    const common = { "aria-label": k.key, "aria-invalid": bad || undefined, className: bad ? "invalid" : undefined, "data-testid": `review-input-${k.key}` };
                    const cls = pathClassOf(k.key) as RiskPathClass | null;
                    return (
                      <tr key={k.key} data-testid={`review-row-${k.key}`}>
                        <td className="policy-key">
                          {R().key[k.key]}<br /><code className="muted">{k.key}</code>
                          {cls && current.builtinPaths[cls] && <><br /><span className="muted">{R().builtin(current.builtinPaths[cls].join(", "))}</span></>}
                        </td>
                        <td data-testid={`review-effective-${k.key}`}>{cls ? shown(current.unions[cls] ?? []) : shown(k.effective)}</td>
                        <td className="muted">{S.lp.origin(k.origin)}</td>
                        <td>
                          {k.def.kind === "bool" || k.def.kind === "enum" ? (
                            <select {...common} value={raw} onChange={(e) => set(e.target.value)}>
                              <option value="">{S.lp.inherit}</option>
                              {(k.def.kind === "bool" ? ["true", "false"] : k.def.options).map((o) => (
                                <option key={o} value={o}>{k.def.kind === "bool" ? S.lp.bool(o === "true") : (R().option[o] ?? o)}</option>
                              ))}
                            </select>
                          ) : k.def.kind === "list" ? (
                            <textarea {...common} rows={3} placeholder={S.lp.inherit} value={raw} onChange={(e) => set(e.target.value)} />
                          ) : (
                            <input {...common} inputMode="numeric" placeholder={S.lp.inherit} title={S.lp.range(k.def.min, k.def.max)} value={raw} onChange={(e) => set(e.target.value)} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          <div className="actions">
            <button className="primary" data-testid="review-save" disabled={busy} onClick={save}>{S.lp.save}</button>
            <button data-testid="review-discard" disabled={busy || Object.keys(draft).length === 0} onClick={() => setDraft({})}>{S.lp.discard}</button>
            <button data-testid="review-clear" disabled={busy || current.keys.every((k) => k.override === null)} onClick={() => void write({})}>{S.lp.clear}</button>
          </div>
          {message && <p className={message.error ? "error" : "muted"} role="status" data-testid="review-message">{message.text}</p>}
        </>
      )}
    </div>
  );
}
