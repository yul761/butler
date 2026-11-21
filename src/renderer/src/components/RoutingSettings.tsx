import { useEffect, useState } from "react";
import type { LimitKind } from "../../../shared/availability";
import {
  POLICIES, TIERS, type LimitPolicy, type LimitRuleKind, type RegistryModel, type RoutingAction, type RoutingView, type TaskRouteView, type Tier,
} from "../../../shared/model-routing";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import { api } from "../api";
import { reportError } from "../errors";
import { TONE_PILL, timeText } from "../lesson-runs-view";
import { formatUsd } from "../format";
import { chainText, healthText, HEALTH_TONE, parseChain } from "../routing-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const LIMIT_KINDS: LimitKind[] = ["usage_limit", "rate_limit", "overloaded", "model_unavailable"];
const SETTING_FIELDS = ["routingQuotas", "routingThresholds", "routingPeriodStartDay", "routingEffort", "routingMaxConcurrent"] as const;
const RULE_KINDS: LimitRuleKind[] = ["regex", "status", "reset"];

/** 设置 → 模型路由（3.0）：登记的模型和健康、每档顺序、任务表、花费和配额、事件、未识别的报错、识别规则。 */
export function RoutingSettings() {
  const view = useStateRefetch("routing", api.routingView);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!view) return <p className="muted">{S.loading}</p>;
  const act = async (a: RoutingAction) => {
    setBusy(true);
    setError(null);
    try {
      const err = await api.routingAct(a);
      if (err) setError(err);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const p = { view, act, busy };
  return (
    <div className="routing-settings" data-testid="routing-settings">
      <h2>{S.rt.title}</h2>
      <p className="muted" data-testid="routing-status">{view.configured ? S.rt.configured : S.rt.unconfigured}</p>
      {!view.flags.model && <p className="error">{S.rt.noModelFlag}</p>}
      {error && <p className="error" data-testid="routing-error">{error}</p>}
      <Discovery {...p} />
      <Registry {...p} />
      {view.configured && <Chains {...p} />}
      <Tasks {...p} />
      <Spend view={view} />
      <Limits />
      <section>
        <h3>{S.rt.rerunTitle}</h3>
        <p className="muted">{S.rt.rerunHint}</p>
        <div className="actions"><button disabled={busy} onClick={() => void act({ op: "rerunDegraded" })}>{S.rt.rerun}</button></div>
      </section>
      <Unrecognized {...p} />
      <Events view={view} />
      <Rules {...p} />
    </div>
  );
}

interface Part {
  view: RoutingView;
  act: (a: RoutingAction) => Promise<void>;
  busy: boolean;
}

const newModel = (name: string, tier: Tier): RegistryModel => ({ name, tier, enabled: true, account: "default", priceIn: null, priceOut: null, note: "" });

function Discovery({ view, act, busy }: Part) {
  const d = view.discovery;
  const registered = new Set(view.registry.map((m) => m.name));
  return (
    <section data-testid="routing-discovery">
      <h3>{S.rt.discoverTitle}</h3>
      <p className="muted">{S.rt.discoverHint}</p>
      <div className="actions">
        <button className="primary" disabled={busy || d?.running} onClick={() => void act({ op: "discover" })}>{d?.running ? S.rt.discovering : S.rt.discover}</button>
        {d?.at && <span className="muted">{S.rt.discoveredAt(timeText(d.at))}</span>}
      </div>
      {d && d.models.length > 0 && (
        <table className="ticket-table">
          <tbody>
            {d.models.map((m) => (
              <tr key={m.name} data-testid="discovered-model">
                <td><code>{m.name}</code> <small className="muted">{m.from}</small></td>
                <td><span className={`pill ${TONE_PILL[m.status === "available" ? "ok" : m.status === "limited" ? "warn" : m.status === "pending" ? "muted" : "danger"]}`}>{S.rt.discoveryStatus[m.status]}</span></td>
                <td>
                  {registered.has(m.name) ? <span className="muted">{S.rt.registered}</span> : m.status === "available" || m.status === "limited" ? (
                    <button disabled={busy} onClick={() => void act({ op: "addModel", model: newModel(m.name, m.suggestedTier ?? "mid") })}>{S.rt.addAs(S.rt.tier[m.suggestedTier ?? "mid"]!)}</button>
                  ) : <small className="muted">{m.message}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Registry({ view, act, busy }: Part) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState<Tier>("mid");
  const health = new Map(view.health.map((h) => [h.model, h]));
  const price = (v: string): number | null => (v.trim() === "" ? null : Number(v));
  return (
    <section data-testid="routing-registry">
      <h3>{S.rt.registryTitle}</h3>
      {view.registry.length > 0 && (
        <table className="ticket-table">
          <thead>
            <tr><th>{S.rt.colName}</th><th>{S.rt.colTier}</th><th>{S.rt.colAccount}</th><th>{S.rt.colEnabled}</th><th>{S.rt.colPrice}</th><th>{S.rt.colHealth}</th><th /></tr>
          </thead>
          <tbody>
            {view.registry.map((m) => {
              const h = health.get(m.name);
              const patch = (pt: Partial<Omit<RegistryModel, "name">>) => void act({ op: "updateModel", name: m.name, patch: pt });
              return (
                <tr key={m.name} data-testid="registry-row">
                  <td><code>{m.name}</code></td>
                  <td>
                    <select value={m.tier} disabled={busy} onChange={(e) => patch({ tier: e.target.value as Tier })}>
                      {TIERS.map((t) => <option key={t} value={t}>{S.rt.tier[t]}</option>)}
                    </select>
                  </td>
                  <td><BlurInput value={m.account} size={8} onCommit={(v) => patch({ account: v })} /></td>
                  <td><input type="checkbox" checked={m.enabled} disabled={busy} onChange={(e) => patch({ enabled: e.target.checked })} /></td>
                  <td>
                    <BlurInput value={m.priceIn === null ? "" : String(m.priceIn)} size={5} onCommit={(v) => patch({ priceIn: price(v) })} />
                    {" / "}
                    <BlurInput value={m.priceOut === null ? "" : String(m.priceOut)} size={5} onCommit={(v) => patch({ priceOut: price(v) })} />
                  </td>
                  <td><span className={`pill ${TONE_PILL[HEALTH_TONE[h?.state ?? "ok"]]}`} data-testid="health-pill">{healthText(h, S)}</span></td>
                  <td className="row-actions">
                    <button title={S.rt.moveUp} disabled={busy} onClick={() => void act({ op: "moveModel", name: m.name, delta: -1 })}>↑</button>
                    <button title={S.rt.moveDown} disabled={busy} onClick={() => void act({ op: "moveModel", name: m.name, delta: 1 })}>↓</button>
                    <button disabled={busy} onClick={() => void act({ op: "probe", model: m.name })}>{S.rt.probe}</button>
                    {h && h.state !== "ok" && <button disabled={busy} onClick={() => void act({ op: "clearHealth", model: m.name })}>{S.rt.clearHealth}</button>}
                    <button disabled={busy} onClick={() => void act({ op: "removeModel", name: m.name })}>{S.rt.remove}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void act({ op: "addModel", model: newModel(name.trim(), tier) }).then(() => setName(""));
        }}
      >
        <input data-testid="new-model-name" placeholder={S.rt.newModelName} value={name} onChange={(e) => setName(e.target.value)} />
        <select data-testid="new-model-tier" value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
          {TIERS.map((t) => <option key={t} value={t}>{S.rt.tier[t]}</option>)}
        </select>
        <button type="submit" disabled={busy || !name.trim()}>{S.rt.addModel}</button>
      </form>
    </section>
  );
}

function Chains({ view, act, busy }: Part) {
  return (
    <section>
      <h3>{S.rt.chainsTitle}</h3>
      <p className="muted">{S.rt.chainsHint}</p>
      <dl className="kv">
        {TIERS.map((t) => (
          <div key={t} style={{ display: "contents" }}>
            <dt>{S.rt.tier[t]}</dt>
            <dd>
              <BlurInput value={chainText(view, t)} placeholder={view.effectiveChains[t].join(", ")} size={40} disabled={busy} onCommit={(v) => void act({ op: "setChain", tier: t, models: parseChain(v) })} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Tasks({ view, act, busy }: Part) {
  const set = (r: TaskRouteView, patch: { tier?: Tier; minTier?: Tier; policy?: LimitPolicy; critical?: boolean }) =>
    void act({
      op: "setTaskRoute",
      route: {
        task: r.task, tier: r.route.tier === "session" ? null : (patch.tier ?? r.route.tier), minTier: patch.minTier ?? r.route.minTier,
        policy: patch.policy ?? r.route.policy, critical: patch.critical ?? r.route.critical,
      },
    });
  const first = (r: TaskRouteView) => (r.route.tier === "session" ? S.rt.sessionTier : (r.first ?? S.rt.defaultModel));
  return (
    <section data-testid="routing-tasks">
      <h3>{S.rt.tasksTitle}</h3>
      <table className="ticket-table">
        <thead>
          <tr><th>{S.rt.colTask}</th><th>{S.rt.colTier}</th><th>{S.rt.colMinTier}</th><th>{S.rt.colPolicy}</th><th>{S.rt.colCritical}</th><th>{S.rt.colFirst}</th><th /></tr>
        </thead>
        <tbody>
          {view.tasks.map((r) => (
            <tr key={r.task} data-testid={`task-${r.task}`}>
              <td><code>{r.task}</code>{r.route.overridden && <small className="muted"> {S.rt.overridden}</small>}</td>
              <td>
                {r.route.tier === "session" ? <span className="muted">{S.rt.sessionTier}</span> : (
                  <select value={r.route.tier} disabled={busy} onChange={(e) => set(r, { tier: e.target.value as Tier })}>
                    {TIERS.map((t) => <option key={t} value={t}>{S.rt.tier[t]}</option>)}
                  </select>
                )}
              </td>
              <td>
                <select value={r.route.minTier} disabled={busy} onChange={(e) => set(r, { minTier: e.target.value as Tier })}>
                  {TIERS.map((t) => <option key={t} value={t}>{S.rt.tier[t]}</option>)}
                </select>
              </td>
              <td>
                <select value={r.route.policy} disabled={busy} onChange={(e) => set(r, { policy: e.target.value as LimitPolicy })}>
                  {POLICIES.map((x) => <option key={x} value={x}>{S.rt.policy[x]}</option>)}
                </select>
              </td>
              <td><input type="checkbox" checked={r.route.critical} disabled={busy} onChange={(e) => set(r, { critical: e.target.checked })} /></td>
              <td title={r.candidates.join(" → ")}>{first(r)}</td>
              <td>{r.route.overridden && <button disabled={busy} onClick={() => void act({ op: "clearTaskRoute", task: r.task })}>{S.rt.resetTask}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Spend({ view }: { view: RoutingView }) {
  const lines = (title: string, rows: RoutingView["spend"]["byModel"]) => (
    <>
      <h4>{title}</h4>
      <table className="ticket-table">
        <thead><tr><th /><th>{S.rt.colTokens}</th><th>{S.rt.colUsd}</th></tr></thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.key}><td><code>{l.key}</code></td><td>{l.tokens.toLocaleString()}</td><td>{formatUsd(l.usd)}{l.usdPartial && <small className="muted">{S.rt.partial}</small>}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
  return (
    <section data-testid="routing-spend">
      <h3>{S.rt.spendTitle}</h3>
      <p className="muted">{S.rt.periodFrom(timeText(view.spend.periodStart))}</p>
      {view.spend.quotas.length > 0 && (
        <dl className="kv">
          {view.spend.quotas.map((q) => (
            <div key={q.target + q.unit} style={{ display: "contents" }}>
              <dt><code>{q.target}</code></dt>
              <dd>
                <span className={`pill ${TONE_PILL[q.level === "ok" ? "ok" : q.level === "soft" ? "warn" : "danger"]}`}>{S.rt.quotaLevel[q.level]}</span>{" "}
                {q.unit === "usd" ? `${formatUsd(q.used)} / ${formatUsd(q.monthly)}` : `${q.used.toLocaleString()} / ${q.monthly.toLocaleString()}`} ({Math.round(q.ratio * 100)}%)
              </dd>
            </div>
          ))}
        </dl>
      )}
      {view.spend.byModel.length > 0 && lines(S.rt.byModel, view.spend.byModel)}
      {view.spend.byTask.length > 0 && lines(S.rt.byTask, view.spend.byTask)}
    </section>
  );
}

/** 配额、阈值、思考强度、并发和自动切换：普通设置，走 settings:set（主进程检查格式）。 */
function Limits() {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<Partial<Record<EditableSettingKey, string>>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void api.settings().then(setValues, reportError);
    load();
    return api.onStateChanged(load);
  }, []);
  if (!values) return null;
  const save = async (k: EditableSettingKey, v: string) => {
    setError(null);
    try {
      await api.setSetting(k, v);
      setDraft((d) => ({ ...d, [k]: undefined }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section data-testid="routing-limits">
      <h3>{S.rt.settingsTitle}</h3>
      <dl className="kv">
        {SETTING_FIELDS.map((k) => (
          <div key={k} style={{ display: "contents" }}>
            <dt><label htmlFor={`rt-${k}`}>{S.rt.fields[k]}</label></dt>
            <dd>
              <input id={`rt-${k}`} data-testid={`setting-${k}`} size={k === "routingQuotas" || k === "routingEffort" ? 50 : 12} value={draft[k] ?? values[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
              {draft[k] !== undefined && draft[k] !== values[k] && <button onClick={() => void save(k, draft[k]!)}>{S.rt.save}</button>}
            </dd>
          </div>
        ))}
      </dl>
      <label className="check">
        <input type="checkbox" data-testid="setting-routingAutoSwitch" checked={values.routingAutoSwitch === "1"} onChange={(e) => void save("routingAutoSwitch", e.target.checked ? "1" : "0")} />
        {S.rt.autoSwitch}
      </label>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Unrecognized({ view, act, busy }: Part) {
  const [category, setCategory] = useState<Record<number, LimitKind>>({});
  const [account, setAccount] = useState<Record<number, boolean>>({});
  return (
    <section data-testid="routing-unrecognized">
      <h3>{S.rt.unrecTitle}</h3>
      <p className="muted">{S.rt.unrecHint}</p>
      {view.unrecognized.length === 0 ? <p className="muted">{S.rt.noUnrec}</p> : (
        <table className="ticket-table">
          <tbody>
            {view.unrecognized.map((u) => (
              <tr key={u.id} data-testid="unrecognized-row">
                <td>
                  <pre className="sample">{u.sample}</pre>
                  <small className="muted">{S.rt.seen(u.count, timeText(u.lastSeen))} · {S.rt.signal[u.signal]} · {u.models.join(", ")}</small>
                </td>
                <td>
                  {u.status === "open" ? (
                    <div className="row-actions">
                      <select value={category[u.id] ?? "usage_limit"} onChange={(e) => setCategory((c) => ({ ...c, [u.id]: e.target.value as LimitKind }))}>
                        {LIMIT_KINDS.map((k) => <option key={k} value={k}>{S.rt.category[k]}</option>)}
                      </select>
                      <label className="check"><input type="checkbox" checked={account[u.id] ?? false} onChange={(e) => setAccount((a) => ({ ...a, [u.id]: e.target.checked }))} />{S.rt.accountLevel}</label>
                      <button data-testid="confirm-limit" disabled={busy} onClick={() => void act({ op: "confirmError", id: u.id, category: category[u.id] ?? "usage_limit", accountLevel: account[u.id] ?? false })}>{S.rt.isLimit}</button>
                      <button disabled={busy} onClick={() => void act({ op: "dismissError", id: u.id })}>{S.rt.notLimit}</button>
                    </div>
                  ) : <span className="muted">{S.rt.unrecStatus[u.status]}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Events({ view }: { view: RoutingView }) {
  return (
    <section data-testid="routing-events">
      <h3>{S.rt.eventsTitle}</h3>
      {view.events.length === 0 ? <p className="muted">{S.rt.noEvents}</p> : (
        <table className="ticket-table">
          <tbody>
            {view.events.slice(0, 50).map((e) => (
              <tr key={e.id}>
                <td className="muted">{timeText(e.at)}</td>
                <td>{S.rt.event[e.kind] ?? e.kind}</td>
                <td>{e.task && <code>{e.task}</code>}</td>
                <td>{e.model}{e.toModel && ` → ${e.toModel}`}</td>
                <td className="muted">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Rules({ view, act, busy }: Part) {
  const [pattern, setPattern] = useState("");
  const [kind, setKind] = useState<LimitRuleKind>("regex");
  const [category, setCategory] = useState<LimitKind>("usage_limit");
  const [account, setAccount] = useState(false);
  return (
    <section data-testid="routing-rules">
      <h3>{S.rt.rulesTitle}</h3>
      <table className="ticket-table">
        <tbody>
          {view.rules.map((r) => (
            <tr key={r.id}>
              <td><input type="checkbox" checked={r.enabled} disabled={busy} onChange={(e) => void act({ op: "toggleRule", id: r.id, enabled: e.target.checked })} /></td>
              <td>{S.rt.ruleSource[r.source]}</td>
              <td><code style={{ overflowWrap: "anywhere" }}>{r.pattern}</code></td>
              <td>{r.category ? S.rt.category[r.category] : S.rt.ruleKind[r.kind]}{r.accountLevel && ` · ${S.rt.accountLevel}`}</td>
              <td>{r.source !== "builtin" && <button disabled={busy} onClick={() => void act({ op: "removeRule", id: r.id })}>{S.rt.remove}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>{S.rt.addRuleTitle}</h4>
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault();
          void act({ op: "addRule", rule: { kind, pattern, category: kind === "reset" ? null : category, accountLevel: account, note: "" } }).then(() => setPattern(""));
        }}
      >
        <select value={kind} onChange={(e) => setKind(e.target.value as LimitRuleKind)}>
          {RULE_KINDS.map((k) => <option key={k} value={k}>{S.rt.ruleKind[k]}</option>)}
        </select>
        <input placeholder={S.rt.rulePattern} value={pattern} onChange={(e) => setPattern(e.target.value)} />
        {kind !== "reset" && (
          <select value={category} onChange={(e) => setCategory(e.target.value as LimitKind)}>
            {LIMIT_KINDS.map((k) => <option key={k} value={k}>{S.rt.category[k]}</option>)}
          </select>
        )}
        <label className="check"><input type="checkbox" checked={account} onChange={(e) => setAccount(e.target.checked)} />{S.rt.accountLevel}</label>
        <button type="submit" disabled={busy || !pattern.trim()}>{S.rt.addRule}</button>
      </form>
    </section>
  );
}

/** 失去焦点或回车时才提交的输入框。 */
function BlurInput({ value, onCommit, size, placeholder, disabled }: { value: string; onCommit: (v: string) => void; size?: number; placeholder?: string; disabled?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  return (
    <input
      value={v} size={size} placeholder={placeholder} disabled={disabled}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}
