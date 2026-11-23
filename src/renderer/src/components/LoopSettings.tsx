import { useCallback, useEffect, useState } from "react";
import { EXTERNAL_ACTION_SETTINGS } from "../../../shared/external";
import type { LoopPolicyOverrides, LoopScope } from "../../../shared/loop-policy";
import type { FlakyKind } from "../../../shared/loop";
import type { EditableSettings } from "../../../shared/settings";
import { api, ShipherdError } from "../api";
import { reportError } from "../errors";
import { loopGroups, loopInputValue, loopOverridesFromDraft, parseLoopInput, type LoopDraft } from "../loop-view";
import { policyScopeFromKey, policyScopeKey } from "../policy-view";
import { S } from "../strings";
import { resetClock } from "../availability-view";
import { useStateRefetch } from "./useStateRefetch";

const EFFECT_DAYS = 30;
/** 这一页相关的对外动作（契约 4.8）。 */
const LOOP_ACTIONS = ["comment_reply", "comment_resolve", "ci_rerun"] as const;

/** 设置 →「评论与 CI」（工作流 I）：三层策略、对外动作开关、flaky 名单、最近 30 天的效果。 */
export function LoopSettings() {
  return (
    <section className="loop-settings" data-testid="loop-settings">
      <h2>{S.lp.title}</h2>
      <p className="muted">{S.lp.intro}</p>
      <LoopPolicyEditor />
      <LoopExternalSwitches />
      <FlakyList />
      <LoopEffectSummary />
    </section>
  );
}

function LoopPolicyEditor() {
  const lessons = useStateRefetch("loop-layers", api.lessonsState);
  const [scope, setScope] = useState<LoopScope>({ kind: "global" });
  const key = policyScopeKey(scope);
  const view = useStateRefetch(`loop-policy-${key}`, () => api.loopPolicyGet(scope));
  const [draft, setDraft] = useState<LoopDraft>({});
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (v: string) => {
    setScope(policyScopeFromKey(v));
    setDraft({});
    setMessage(null);
  };
  const write = async (overrides: LoopPolicyOverrides) => {
    setBusy(true);
    try {
      await api.loopPolicySet(scope, overrides);
      setDraft({});
      setMessage({ text: S.lp.saved, error: false });
    } catch (e) {
      if (e instanceof ShipherdError) setMessage({ text: e.message, error: true });
      else reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!current) return;
    const r = loopOverridesFromDraft(current, draft);
    if (!r.ok) return setMessage({ text: S.lp.badValue(S.lp.key[r.badKey as keyof typeof S.lp.key] ?? r.badKey), error: true });
    if (!r.changed) return setMessage({ text: S.lp.noChange, error: false });
    void write(r.overrides);
  };

  const current = view && policyScopeKey(view.scope) === key ? view : null;
  const shown = (v: unknown): string => (typeof v === "boolean" ? S.lp.bool(v) : Array.isArray(v) ? (v.length ? v.join(", ") : "—") : typeof v === "string" ? (S.lp.option[v] ?? v) : String(v));
  return (
    <div className="field" data-testid="loop-policy-editor">
      <label className="inline">
        {S.lp.layer}
        <select data-testid="loop-layer" value={key} onChange={(e) => pick(e.target.value)}>
          <option value="global">{S.lp.layerGlobal}</option>
          {(lessons?.products ?? []).map((p) => <option key={`p${p.id}`} value={`product:${p.id}`}>{S.lp.layerProduct(p.name)}</option>)}
          {(lessons?.repos ?? []).map((r) => <option key={`r${r.slug}`} value={`repo:${r.slug}`}>{S.lp.layerRepo(r.slug)}</option>)}
        </select>
      </label>
      {current && (
        <>
          {current.conflicts.length > 0 && (
            <div className="lessons-suggest" role="status" data-testid="loop-conflicts">
              <span>{S.lp.conflicts}</span>
              <ul>
                {current.conflicts.map((c) => <li key={c.key}>{S.lp.conflict(c.key, c.products.map((p) => `${p.name} = ${shown(p.value)}`).join(", "))}</li>)}
              </ul>
            </div>
          )}
          {loopGroups(current).map((g) => (
            <div key={g.group}>
              <h4 className="policy-group">{S.lp.group[g.group]}</h4>
              <table className="policy-table">
                <thead>
                  <tr><th>{S.lp.colKey}</th><th>{S.lp.colEffective}</th><th>{S.lp.colFrom}</th><th>{S.lp.colOverride}</th></tr>
                </thead>
                <tbody>
                  {g.keys.map((k) => {
                    const raw = draft[k.key] ?? loopInputValue(k.override);
                    const bad = draft[k.key] !== undefined && parseLoopInput(k.key, raw) === undefined;
                    const set = (v: string) => setDraft((d) => ({ ...d, [k.key]: v }));
                    const common = { "aria-label": k.key, "aria-invalid": bad || undefined, className: bad ? "invalid" : undefined, "data-testid": `loop-input-${k.key}` };
                    return (
                      <tr key={k.key} data-testid={`loop-row-${k.key}`}>
                        <td className="policy-key">{S.lp.key[k.key]}<br /><code className="muted">{k.key}</code></td>
                        <td data-testid={`loop-effective-${k.key}`}>{shown(k.effective)}</td>
                        <td className="muted">{S.lp.origin(k.origin)}</td>
                        <td>
                          {k.def.kind === "bool" || k.def.kind === "enum" ? (
                            <select {...common} value={raw} onChange={(e) => set(e.target.value)}>
                              <option value="">{S.lp.inherit}</option>
                              {(k.def.kind === "bool" ? ["true", "false"] : k.def.options).map((o) => (
                                <option key={o} value={o}>{k.def.kind === "bool" ? S.lp.bool(o === "true") : (S.lp.option[o] ?? o)}</option>
                              ))}
                            </select>
                          ) : k.def.kind === "list" ? (
                            <textarea {...common} rows={3} placeholder={S.lp.inherit} title={S.lp.listHint} value={raw} onChange={(e) => set(e.target.value)} />
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
          <p className="muted">{S.lp.listHint}</p>
          <div className="actions">
            <button className="primary" data-testid="loop-save" disabled={busy} onClick={save}>{S.lp.save}</button>
            <button data-testid="loop-discard" disabled={busy || Object.keys(draft).length === 0} onClick={() => setDraft({})}>{S.lp.discard}</button>
            <button data-testid="loop-clear" disabled={busy || current.keys.every((k) => k.override === null)} onClick={() => void write({})}>{S.lp.clear}</button>
          </div>
          {message && <p className={message.error ? "error" : "muted"} role="status" data-testid="loop-message">{message.text}</p>}
        </>
      )}
    </div>
  );
}

/** 回复、resolve、重跑 CI 的开关：和「常规」里对外动作的是同一组设置，放在这里方便一起开。 */
function LoopExternalSwitches() {
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
  const toggle = async (kind: (typeof LOOP_ACTIONS)[number], on: boolean) => {
    // 先在界面上勾上（受控的复选框要等重读才变）；保存失败时 load 会改回来。
    setValues({ ...current, [EXTERNAL_ACTION_SETTINGS[kind]]: on ? "1" : "0" });
    try {
      await api.setSetting(EXTERNAL_ACTION_SETTINGS[kind], on ? "1" : "0");
      await load();
    } catch (e) {
      reportError(e);
      await load();
    }
  };
  return (
    <div className="field" data-testid="loop-external">
      <h3>{S.lp.externalTitle}</h3>
      <p className="muted">{S.lp.externalIntro}</p>
      {LOOP_ACTIONS.map((kind) => (
        <div key={kind} className="external-action">
          <label className="inline">
            <input type="checkbox" data-testid={`loop-external-${kind}`} checked={current[EXTERNAL_ACTION_SETTINGS[kind]] === "1"} onChange={(e) => void toggle(kind, e.target.checked)} />
            {S.externalActions[kind].label}
          </label>
          <span className="muted"> {S.externalActions[kind].hint}</span>
        </div>
      ))}
    </div>
  );
}

function FlakyList() {
  const rows = useStateRefetch("loop-flaky", api.loopFlaky);
  const policy = useStateRefetch("loop-flaky-days", () => api.loopPolicyGet({ kind: "global" }));
  const days = Number(policy?.keys.find((k) => k.key === "ci.autoListDays")?.effective ?? 30);
  const [repo, setRepo] = useState("");
  const [kind, setKind] = useState<FlakyKind>("test");
  const [name, setName] = useState("");
  // 主进程改完会发 stateChanged，列表自己重取。
  const act = (op: "add" | "remove", r: { repoSlug: string; kind: FlakyKind; name: string }) => api.loopFlakyAct({ op, ...r }).then(() => undefined, reportError);
  const now = Date.now();
  return (
    <div className="field" data-testid="loop-flaky">
      <h3>{S.lp.flakyTitle}</h3>
      <p className="muted">{S.lp.flakyIntro(days)}</p>
      {rows && rows.length === 0 && <p className="empty">{S.lp.flakyEmpty}</p>}
      {rows && rows.length > 0 && (
        <table className="policy-table">
          <thead>
            <tr>
              <th>{S.lp.flakyCols.repo}</th><th>{S.lp.flakyCols.kind}</th><th>{S.lp.flakyCols.name}</th><th>{S.lp.flakyCols.count}</th>
              <th>{S.lp.flakyCols.wasted}</th><th>{S.lp.flakyCols.last}</th><th>{S.lp.flakyCols.listed}</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.repoSlug}|${r.kind}|${r.name}`} data-testid="loop-flaky-row">
                <td>{r.repoSlug}</td>
                <td>{S.lp.flakyKind[r.kind]}</td>
                <td><code>{r.name}</code></td>
                <td>{r.count}</td>
                <td>{S.lp.duration(r.wastedMs)}</td>
                <td className="muted">{r.lastAt === null ? "—" : resetClock(r.lastAt, now)}</td>
                <td>{r.listed === null ? S.lp.flakyNotListed : S.lp.flakyListed[r.listed]}</td>
                <td>
                  <button onClick={() => void act(r.listed === null ? "add" : "remove", r)}>{r.listed === null ? S.lp.flakyAdd : S.lp.flakyRemove}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4 className="policy-group">{S.lp.flakyAddTitle}</h4>
      <div className="actions">
        <input aria-label={S.lp.flakyAddRepo} placeholder={S.lp.flakyAddRepo} data-testid="loop-flaky-repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <select aria-label={S.lp.flakyCols.kind} value={kind} onChange={(e) => setKind(e.target.value as FlakyKind)}>
          <option value="test">{S.lp.flakyKind.test}</option>
          <option value="check">{S.lp.flakyKind.check}</option>
        </select>
        <input aria-label={S.lp.flakyAddName} placeholder={S.lp.flakyAddName} data-testid="loop-flaky-name" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          data-testid="loop-flaky-add"
          disabled={!repo.trim() || !name.trim()}
          onClick={() => void act("add", { repoSlug: repo.trim(), kind, name: name.trim() }).then(() => setName(""))}
        >
          {S.lp.flakyAdd}
        </button>
      </div>
    </div>
  );
}

function LoopEffectSummary() {
  const e = useStateRefetch("loop-effect", () => api.loopEffect(EFFECT_DAYS));
  if (!e) return null;
  const c = e.comments;
  const ci = e.ci;
  return (
    <div className="field" data-testid="loop-effect">
      <h3>{S.lp.effectTitle(EFFECT_DAYS)}</h3>
      <p>{S.lp.effectComments(c.autoHandled, c.byWho.copilot, c.byWho.human, c.replied, c.resolved)}</p>
      {c.waitingForYou > 0 && <p>{S.lp.effectWaiting(c.waitingForYou)}</p>}
      <p>{S.lp.effectCi(ci.triaged, ci.byCategory.env, ci.byCategory.flaky, ci.byCategory.code)}</p>
      <p>{S.lp.effectReruns(ci.reruns, ci.passedAfterRerun, S.lp.duration(ci.flakyWastedMs))}</p>
      <p>{S.lp.effectDelivered(ci.deliveredAsCode, ci.possiblyFlaky)}</p>
    </div>
  );
}
