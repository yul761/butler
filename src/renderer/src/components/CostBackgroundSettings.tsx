import { useCallback, useEffect, useState } from "react";
import type { PolicyScope } from "../../../shared/admission-policy";
import { BG_PRIORITIES, BG_QUOTA_ORDERS, BG_WINDOWS, BG_YIELDS, type BgKindStatus } from "../../../shared/background";
import { COST_ACTIONS, COST_PAUSE_SCOPES, COST_UNITS, type CostBreakerView, type CostPolicyKey } from "../../../shared/cost";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import { resetClock } from "../availability-view";
import { api, ShipherdError } from "../api";
import { costAmount, costBreakerText, costInputValue, costOverridesFromDraft, parseCostInput, withKindOverride, type CostDraft } from "../cost-view";
import { reportError } from "../errors";
import { policyScopeFromKey, policyScopeKey } from "../policy-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const ENUM_OPTIONS: Partial<Record<CostPolicyKey, readonly string[]>> = { unit: COST_UNITS, action: COST_ACTIONS, pauseScope: COST_PAUSE_SCOPES };

/** 花费上限的三层编辑器（契约 4.2）：同复盘规矩里的准入策略编辑器。 */
function CostCaps() {
  const lessons = useStateRefetch("cost-layers", api.lessonsState);
  const [scope, setScope] = useState<PolicyScope>({ kind: "global" });
  const key = policyScopeKey(scope);
  const view = useStateRefetch(`cost-${key}`, () => api.costView(scope));
  const [draft, setDraft] = useState<CostDraft>({});
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = view && policyScopeKey(view.policy.scope) === key ? view : null;

  const pick = (v: string) => {
    setScope(policyScopeFromKey(v));
    setDraft({});
    setMessage(null);
  };
  const write = async (overrides: Parameters<typeof api.costSet>[1]) => {
    setBusy(true);
    try {
      const r = await api.costSet(scope, overrides);
      if (r.ok) {
        setDraft({});
        setMessage({ text: S.policySaved, error: false });
      } else setMessage({ text: r.message, error: true });
    } catch (e) {
      if (e instanceof ShipherdError) setMessage({ text: e.message, error: true });
      else reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!current) return;
    const r = costOverridesFromDraft(current.policy, draft);
    if (!r.ok) return setMessage({ text: S.policyBadValue(r.badKey), error: true });
    if (!r.changed) return setMessage({ text: S.policyNoChange, error: false });
    void write(r.overrides);
  };

  return (
    <div className="field" data-testid="cost-caps">
      <h3>{S.cs.capsTitle}</h3>
      <p className="muted">{S.cs.capsIntro}</p>
      <label className="inline">
        {S.policyLayer}
        <select data-testid="cost-layer" value={key} onChange={(e) => pick(e.target.value)}>
          <option value="global">{S.policyLayerGlobal}</option>
          {(lessons?.products ?? []).map((p) => <option key={`p${p.id}`} value={`product:${p.id}`}>{S.policyLayerProduct(p.name)}</option>)}
          {(lessons?.repos ?? []).map((r) => <option key={`r${r.slug}`} value={`repo:${r.slug}`}>{S.policyLayerRepo(r.slug)}</option>)}
        </select>
      </label>
      {current && (
        <>
          <p className="muted">{S.cs.capsInheritHint}</p>
          <table className="policy-table">
            <thead>
              <tr><th>{S.policyKeyCol}</th><th>{S.policyEffective}</th><th>{S.policyFrom}</th><th>{S.policyOverride}</th></tr>
            </thead>
            <tbody>
              {current.policy.keys.map((k) => {
                const raw = draft[k.key] ?? costInputValue(k.key, k.set, k.override);
                const bad = draft[k.key] !== undefined && parseCostInput(k.key, raw) === undefined;
                const set = (v: string) => setDraft((d) => ({ ...d, [k.key]: v }));
                const options = ENUM_OPTIONS[k.key];
                const shown = k.effective === null ? S.cs.none : typeof k.effective === "string" ? S.cs.option[k.effective] ?? k.effective : String(k.effective);
                return (
                  <tr key={k.key} data-testid={`cost-row-${k.key}`}>
                    <td className="policy-key">{S.cs.key[k.key] ?? k.key}<br /><code className="muted">{k.key}</code></td>
                    <td data-testid={`cost-effective-${k.key}`}>{shown}</td>
                    <td className="muted">{S.policyOrigin(k.origin)}</td>
                    <td>
                      {options ? (
                        <select aria-label={k.key} data-testid={`cost-input-${k.key}`} value={raw} onChange={(e) => set(e.target.value)}>
                          <option value="">{S.policyInherit}</option>
                          {options.map((o) => <option key={o} value={o}>{S.cs.option[o] ?? o}</option>)}
                        </select>
                      ) : (
                        <input
                          aria-label={k.key}
                          aria-invalid={bad || undefined}
                          className={bad ? "invalid" : undefined}
                          data-testid={`cost-input-${k.key}`}
                          placeholder={S.policyInherit}
                          value={raw}
                          onChange={(e) => set(e.target.value)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="actions">
            <button className="primary" data-testid="cost-save" disabled={busy} onClick={save}>{S.policySave}</button>
            <button disabled={busy || Object.keys(draft).length === 0} onClick={() => setDraft({})}>{S.policyDiscard}</button>
            <button disabled={busy || current.policy.keys.every((k) => !k.set)} onClick={() => void write({})}>{S.policyClear}</button>
          </div>
          {message && <p className={message.error ? "error" : "muted"} role={message.error ? "alert" : "status"} data-testid="cost-message">{message.text}</p>}
          <CostBreakers breakers={current.breakers} />
          <h4 className="policy-group">{S.cs.eventsTitle}</h4>
          {current.events.length === 0 ? <p className="muted">{S.cs.eventsEmpty}</p> : (
            <ul className="cost-events" data-testid="cost-events">
              {current.events.slice(0, 20).map((e) => (
                <li key={e.id}>
                  <span className="muted">{resetClock(e.at, Date.now())}</span> {S.cs.event[e.kind] ?? e.kind} · {e.subjectKind} {e.subjectId}
                  {e.spent !== null && e.cap !== null && e.unit !== null && ` · ${costAmount(e.spent, e.unit === "tokens" ? "tokens" : "usd", S)} / ${costAmount(e.cap, e.unit === "tokens" ? "tokens" : "usd", S)}`}
                  {e.detail && <span className="muted"> · {e.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function CostBreakers({ breakers }: { breakers: CostBreakerView[] }) {
  const [result, setResult] = useState<string | null>(null);
  const raise = (b: CostBreakerView) =>
    api.costResume(b.subjectKind, b.subjectId).then((r) => setResult(r.ok ? S.cs.raised(costAmount(r.cap, b.unit, S)) : S.cs.raiseGone), reportError);
  return (
    <>
      <h4 className="policy-group">{S.cs.breakersTitle}</h4>
      {breakers.length === 0 ? <p className="muted">{S.cs.breakersEmpty}</p> : (
        <ul data-testid="cost-breakers">
          {breakers.map((b) => (
            <li key={`${b.subjectKind}:${b.subjectId}`}>
              {costBreakerText(b, S)}{" "}
              {b.state !== "warned" && <button onClick={() => void raise(b)}>{S.cs.raise}</button>}
            </li>
          ))}
        </ul>
      )}
      {result && <p className="muted" role="status">{result}</p>}
    </>
  );
}

const BG_KEYS = ["bgHours", "bgIdleMinutes", "bgPlentifulPercent"] as const satisfies readonly EditableSettingKey[];

/** 后台任务的时段、让路方式、额度紧张时的顺序，和每种任务的优先级 / 时段 / 停用。 */
function BackgroundSettings() {
  const status = useStateRefetch("bg-status", api.backgroundStatus);
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.settings().then(setValues, reportError), []);
  useEffect(() => void load(), [load]);

  const save = async (k: EditableSettingKey, v: string) => {
    setError(null);
    try {
      await api.setSetting(k, v);
      setDraft((d) => {
        const next = { ...d };
        delete next[k];
        return next;
      });
      await load();
    } catch (e) {
      if (e instanceof ShipherdError && e.code === "invalid_setting") setError(e.message);
      else reportError(e);
    }
  };
  if (!values) return <p className="muted">{S.loading}</p>;
  const value = (k: EditableSettingKey) => draft[k] ?? values[k];
  const select = (k: EditableSettingKey, options: readonly string[], labels: Record<string, string>) => (
    <label className="field">
      {S.cs[k === "bgWindow" ? "bgWindow" : k === "bgYield" ? "bgYield" : "bgQuotaOrder"]}
      <select data-testid={`setting-${k}`} value={values[k]} onChange={(e) => void save(k, e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{labels[o] ?? o}</option>)}
      </select>
    </label>
  );
  const label: Record<(typeof BG_KEYS)[number], string> = { bgHours: S.cs.bgHours, bgIdleMinutes: S.cs.bgIdleMinutes, bgPlentifulPercent: S.cs.bgPlentiful };
  const kindPatch = (k: BgKindStatus, patch: Parameters<typeof withKindOverride>[2]) => void save("bgKinds", withKindOverride(values.bgKinds, k.kind, patch));

  return (
    <div className="field" data-testid="bg-settings">
      <h3>{S.cs.bgTitle}</h3>
      <p className="muted">{S.cs.bgIntro}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {status && <p className="muted" data-testid="bg-now">{S.cs.bgNow(status.idle.idle, status.idle.idleSeconds, status.inHours, S.cs.quotaLevel[status.quota.plentiful ? "plentiful" : status.quota.level])}</p>}
      {select("bgWindow", BG_WINDOWS, S.cs.window)}
      {BG_KEYS.map((k) => (
        <label key={k} className="field">
          {label[k]}
          <input data-testid={`setting-${k}`} value={value(k)} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} onBlur={() => draft[k] !== undefined && draft[k] !== values[k] && void save(k, draft[k])} />
        </label>
      ))}
      {select("bgYield", BG_YIELDS, S.cs.yieldMode)}
      {select("bgQuotaOrder", BG_QUOTA_ORDERS, S.cs.quotaOrder)}
      {status && (
        <>
          <h4 className="policy-group">{S.cs.kindsTitle}</h4>
          <table className="policy-table" data-testid="bg-kinds">
            <thead>
              <tr><th>{S.cs.colKind}</th><th>{S.cs.colPriority}</th><th>{S.cs.colWindow}</th><th>{S.cs.colState}</th><th>{S.cs.colQueue}</th><th /></tr>
            </thead>
            <tbody>
              {status.kinds.map((k) => (
                <tr key={k.kind} data-testid={`bg-kind-${k.kind}`}>
                  <td>{S.cs.kind[k.kind] ?? k.kind}<br /><code className="muted">{k.kind}</code></td>
                  <td>
                    <select aria-label={`${k.kind} priority`} value={k.override?.priority ?? ""} onChange={(e) => kindPatch(k, { priority: (e.target.value || undefined) as BgKindStatus["priority"] | undefined })}>
                      <option value="">{S.cs.priority[k.priority]} ({S.policyInherit})</option>
                      {BG_PRIORITIES.map((p) => <option key={p} value={p}>{S.cs.priority[p]}</option>)}
                    </select>
                  </td>
                  <td>
                    {k.idleEligible ? (
                      <select aria-label={`${k.kind} window`} value={k.override?.window ?? ""} onChange={(e) => kindPatch(k, { window: (e.target.value || undefined) as BgKindStatus["window"] | undefined })}>
                        <option value="">{S.cs.followGlobal}</option>
                        {BG_WINDOWS.map((w) => <option key={w} value={w}>{S.cs.window[w]}</option>)}
                      </select>
                    ) : <span className="muted">{S.cs.window.anytime}</span>}
                  </td>
                  <td>{k.gate.run ? S.cs.gateRun : `${S.cs.gate[k.gate.reason]}${k.gate.until !== null ? ` ${S.cs.until(resetClock(k.gate.until, Date.now()))}` : ""}`}</td>
                  <td>{k.queued} / {k.running}</td>
                  <td>
                    <button data-testid={`bg-kind-toggle-${k.kind}`} onClick={() => void api.backgroundAct({ op: k.override?.paused ? "resumeKind" : "pauseKind", kind: k.kind }).then(load, reportError)}>
                      {k.override?.paused ? S.cs.resumeKind : S.cs.pauseKind}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** 设置页「花费与后台」（工作流 L）。 */
export function CostBackgroundSettings() {
  return (
    <section className="settings-section" data-testid="cost-background-settings">
      <h2>{S.set.groups.cost}</h2>
      <CostCaps />
      <BackgroundSettings />
    </section>
  );
}
