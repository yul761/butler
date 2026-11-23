import { useState } from "react";
import type { BaselineCheck, BaselineRepoView, BaselinesAction, RuleRowView } from "../../../shared/baselines";
import type { CheckScope } from "../../../shared/checks";
import type { EditableSettingKey } from "../../../shared/settings";
import { api, ShipherdError } from "../api";
import { reportError } from "../errors";
import { parseScopeKey, scopeKey } from "../checks-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Msg = { text: string; error: boolean } | null;

async function act(a: BaselinesAction, setMsg: (m: Msg) => void): Promise<boolean> {
  try {
    const r = await api.baselinesAct(a);
    if (!r.ok) setMsg({ text: r.message, error: true });
    else setMsg(r.created !== undefined ? { text: S.bl.adopted(r.created), error: false } : r.message ? { text: r.message, error: false } : null);
    return r.ok;
  } catch (e) {
    reportError(e);
    return false;
  }
}

/** 一个仓库扫描出来的检查，一行一条。 */
function ChecksTable({ checks }: { checks: BaselineCheck[] }) {
  if (checks.length === 0) return <p className="muted">{S.bl.noChecks}</p>;
  return (
    <table className="baseline-checks">
      <thead>
        <tr>
          <th>{S.bl.colCategory}</th>
          <th>{S.bl.colTool}</th>
          <th>{S.bl.colCommand}</th>
          <th>{S.bl.colWhere}</th>
          <th>{S.bl.colChanged}</th>
          <th>{S.bl.colConfidence}</th>
          <th>{S.bl.colSource}</th>
          <th>{S.bl.colEvidence}</th>
        </tr>
      </thead>
      <tbody>
        {checks.map((c) => (
          <tr key={c.id} data-testid={`baseline-check-${c.id}`}>
            <td>{S.bl.category[c.category] ?? c.category}{c.dir ? <span className="muted"> · {c.dir}</span> : null}</td>
            <td>{c.tool}</td>
            <td><code>{c.command}</code></td>
            <td>{c.stages.length ? c.stages.map((s) => S.bl.stage[s] ?? s).join(", ") : <span className="muted">{S.bl.stageNone}</span>}</td>
            <td>{c.changedFiles ? S.bl.yes : S.bl.no}</td>
            <td><span className={`pill ${c.confidence === "high" ? "approved" : c.confidence === "medium" ? "pending" : "none"}`}>{S.bl.confidence[c.confidence]}</span></td>
            <td>{S.bl.source[c.source]}</td>
            <td className="muted">{c.evidence.join("; ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 一个仓库：状态、扫描按钮、检查表、建议、可直接用的检查草稿、档案。 */
function RepoBlock({ r, infer }: { r: BaselineRepoView; infer: boolean }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [showProfile, setShowProfile] = useState(false);
  const b = r.latest;
  const counts = { high: 0, medium: 0, low: 0 };
  for (const c of b?.checks ?? []) counts[c.confidence]++;
  const usable = r.drafts.filter((d) => !d.exists);
  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleConfirm = (id: string) => setConfirmed((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const live = picked.filter((id) => usable.some((d) => d.id === id && (!d.needsConfirm || confirmed.includes(id))));
  const adopt = async () => {
    if (!live.length) return;
    if (await act({ kind: "adopt", slug: r.slug, ids: live, confirmLow: confirmed.filter((id) => live.includes(id)) }, setMsg)) {
      setPicked([]);
      setConfirmed([]);
    }
  };
  const id = r.slug.replace(/[^a-zA-Z0-9]+/g, "-");
  return (
    <div className="lesson confirmed baseline-repo" data-testid={`baseline-repo-${id}`}>
      <div className="lessons-row">
        <strong className="lesson-text">{r.slug}</strong>
        {!r.path && <span className="pill none">{S.bl.notCloned}</span>}
        {b && <span className={`pill ${b.status === "ok" ? "approved" : b.status === "partial" ? "pending" : "changes"}`} data-testid={`baseline-status-${id}`}>{S.bl.status[b.status]}</span>}
        {b?.skipReason && <span className="muted">{S.bl.skip[b.skipReason]}{b.detail ? ` · ${b.detail}` : ""}</span>}
        {b?.staleAt != null && <span className="pill pending" data-testid={`baseline-stale-${id}`}>{S.bl.stale}</span>}
        {b?.origin === "imported" && <span className="pill none">{S.bl.imported}</span>}
        {b && b.inferred !== "none" && <span className="pill none" title={b.inferDetail ?? undefined}>{S.bl.inferred[b.inferred]}</span>}
        <span className="muted">{b ? S.bl.scannedAt(formatTime(b.scannedAt)) : S.bl.never}</span>
        {r.running ? (
          <>
            <span className="muted" role="status">{S.bl.running}</span>
            <button data-testid={`baseline-cancel-${id}`} onClick={() => void act({ kind: "cancel", slug: r.slug }, setMsg)}>{S.bl.cancel}</button>
          </>
        ) : (
          <button data-testid={`baseline-scan-${id}`} disabled={!r.path} onClick={() => void act({ kind: "scan", slugs: [r.slug], infer, force: true }, setMsg)}>{b ? S.bl.rescan : S.bl.scan}</button>
        )}
      </div>
      {msg && <p className={msg.error ? "error" : "muted"} role={msg.error ? "alert" : "status"} data-testid={`baseline-msg-${id}`}>{msg.text}</p>}
      {b && b.status !== "skipped" && b.status !== "failed" && (
        <>
          <p className="muted">{S.bl.counts(counts.high, counts.medium, counts.low)}</p>
          {b.projects.length > 1 && (
            <p className="muted">{S.bl.projects}: {b.projects.map((p) => `${p.dir || S.bl.root} (${p.langs.join("/")}${p.pm ? `, ${p.pm}` : ""})`).join(" · ")}</p>
          )}
          <h4>{S.bl.checks}</h4>
          <ChecksTable checks={b.checks} />
          {b.advice.length > 0 && (
            <div className="lessons-suggest" data-testid={`baseline-advice-${id}`}>
              <strong>{S.bl.advice}</strong>
              <ul>{b.advice.map((a) => <li key={a.dir}>{S.bl.adviceLine(a.dir || S.bl.root, a.missing.map((m) => S.bl.category[m] ?? m).join(", "))}</li>)}</ul>
            </div>
          )}
          {r.drafts.length > 0 && (
            <div className="baseline-drafts-box" data-testid={`baseline-drafts-${id}`}>
              <h4>{S.bl.drafts}</h4>
              {r.drafts.some((d) => d.needsConfirm) && <p className="muted">{S.bl.lowNote}</p>}
              <ul className="baseline-drafts">
                {r.drafts.map((d) => (
                  <li key={d.id} className="lessons-row">
                    <input type="checkbox" aria-label={d.input.name} data-testid={`baseline-draft-${d.id}`} disabled={d.exists} checked={picked.includes(d.id)} onChange={() => togglePick(d.id)} />
                    <span>{d.input.name}</span>
                    <code>{String((d.input.params as { command?: unknown }).command ?? "")}</code>
                    <span className={`pill ${d.confidence === "high" ? "approved" : d.confidence === "medium" ? "pending" : "none"}`}>{S.bl.confidence[d.confidence]}</span>
                    {d.exists && <span className="muted">{S.bl.draftExists}</span>}
                    {d.needsConfirm && !d.exists && picked.includes(d.id) && (
                      <label className="inline">
                        <input type="checkbox" data-testid={`baseline-confirm-${d.id}`} checked={confirmed.includes(d.id)} onChange={() => toggleConfirm(d.id)} />
                        {S.bl.confirmLow}
                      </label>
                    )}
                  </li>
                ))}
              </ul>
              <button className="primary" data-testid={`baseline-adopt-${id}`} disabled={!live.length} onClick={() => void adopt()}>{S.bl.adopt(live.length)}</button>
            </div>
          )}
          <button className="link" data-testid={`baseline-profile-toggle-${id}`} onClick={() => setShowProfile(!showProfile)}>{S.bl.profile}</button>
          {showProfile && <pre className="check-hit-detail" data-testid={`baseline-profile-${id}`}>{r.profileText || S.bl.profileEmpty}</pre>}
        </>
      )}
    </div>
  );
}

/** 标记文件表：选一层，看每条规则的来源，改这一层的字段 / 停用 / 新加。 */
function RulesEditor({ layers }: { layers: { key: string; label: string }[] }) {
  const [layer, setLayer] = useState("global");
  const scope: CheckScope = parseScopeKey(layer);
  const rows = useStateRefetch(`baseline-rules-${layer}`, () => api.baselinesRules(scope));
  const [editing, setEditing] = useState<{ key: string; json: string; isNew: boolean } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const save = async (key: string, rule: string, enabled: boolean) => {
    if (await act({ kind: "ruleSave", scope, key, rule, enabled }, setMsg)) setEditing(null);
  };
  const row = (r: RuleRowView) => (
    <li key={r.key} className="lessons-row" data-testid={`baseline-rule-${r.key}`}>
      <code>{r.key}</code>
      <span className="pill none">{S.bl.ruleOrigin[r.origin]}</span>
      {r.overridden && <span className="pill pending">{S.bl.ruleOverridden}</span>}
      {!r.enabled && <span className="pill none">{S.bl.ruleOff}</span>}
      {r.invalid && <span className="error">{S.bl.ruleInvalid(r.invalid)}</span>}
      <button data-testid={`baseline-rule-edit-${r.key}`} onClick={() => setEditing({ key: r.key, json: r.raw ?? "{}", isNew: false })}>{S.bl.ruleEdit}</button>
      <button data-testid={`baseline-rule-toggle-${r.key}`} onClick={() => void save(r.key, r.raw ?? "{}", !r.enabled)}>{r.enabled ? S.bl.ruleDisable : S.bl.ruleEnable}</button>
      {r.overridden && <button data-testid={`baseline-rule-remove-${r.key}`} onClick={() => void act({ kind: "ruleRemove", scope, key: r.key }, setMsg)}>{S.bl.ruleRemove}</button>}
    </li>
  );
  const current = rows;
  return (
    <details className="checks-settings" data-testid="baseline-rules">
      <summary>{S.bl.rules}</summary>
      <p className="muted">{S.bl.rulesIntro}</p>
      <div className="lessons-row">
        <select data-testid="baseline-rules-layer" value={layer} onChange={(e) => {
            setLayer(e.target.value);
            setEditing(null);
            setMsg(null);
          }}
        >
          {layers.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <button data-testid="baseline-rule-new" onClick={() => setEditing({ key: "", json: "{\n  \"kind\": \"marker\",\n  \"files\": [],\n  \"lang\": \"\",\n  \"project\": true\n}", isNew: true })}>{S.bl.ruleNew}</button>
      </div>
      {editing && (
        <div className="field" data-testid="baseline-rule-form">
          {editing.isNew && (
            <label className="field">
              {S.bl.ruleKey}
              <input data-testid="baseline-rule-key" value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value })} />
            </label>
          )}
          <label className="field">
            {S.bl.ruleJson} {!editing.isNew && <code>{editing.key}</code>}
            <textarea data-testid="baseline-rule-json" rows={8} value={editing.json} onChange={(e) => setEditing({ ...editing, json: e.target.value })} />
          </label>
          <div className="lessons-row">
            <button className="primary" data-testid="baseline-rule-save" onClick={() => void save(editing.key.trim(), editing.json, current?.find((r) => r.key === editing.key)?.enabled ?? true)}>{S.bl.ruleSave}</button>
            <button onClick={() => setEditing(null)}>{S.lessonsCancel}</button>
          </div>
        </div>
      )}
      {msg && <p className={msg.error ? "error" : "muted"} role={msg.error ? "alert" : "status"}>{msg.text}</p>}
      {current && <ul className="baseline-rules">{current.map(row)}</ul>}
    </details>
  );
}

const NUM_KEYS = ["baselineGuideChars", "legacyScanMaxFiles"] as const satisfies readonly EditableSettingKey[];

/** 四个设置：模型补全、自动重扫立刻生效，数字失焦时保存。 */
function BaselineSettings() {
  const settings = useStateRefetch("baseline-settings", api.settings);
  const [draft, setDraft] = useState<Partial<Record<(typeof NUM_KEYS)[number], string>>>({});
  const [error, setError] = useState<string | null>(null);
  if (!settings) return null;
  const save = async (k: EditableSettingKey, v: string) => {
    setError(null);
    try {
      await api.setSetting(k, v);
      setDraft((d) => {
        const next = { ...d };
        delete next[k as (typeof NUM_KEYS)[number]];
        return next;
      });
    } catch (e) {
      if (e instanceof ShipherdError && e.code === "invalid_setting") setError(e.message);
      else reportError(e);
    }
  };
  return (
    <details className="checks-settings" data-testid="baseline-settings">
      <summary>{S.bl.settings}</summary>
      <label className="inline">
        {S.bl.settingInfer}
        <select data-testid="setting-baselineInfer" value={settings.baselineInfer} onChange={(e) => void save("baselineInfer", e.target.value)}>
          <option value="auto">{S.bl.settingInferAuto}</option>
          <option value="off">{S.bl.settingInferOff}</option>
        </select>
      </label>
      <label className="inline">
        <input type="checkbox" data-testid="setting-baselineAutoRescan" checked={settings.baselineAutoRescan === "1"} onChange={(e) => void save("baselineAutoRescan", e.target.checked ? "1" : "0")} />
        {S.bl.settingAutoRescan}
      </label>
      {NUM_KEYS.map((k) => (
        <label key={k} className="field">
          {k === "baselineGuideChars" ? S.bl.settingGuideChars : S.bl.settingLegacyMax}
          <input
            type="number"
            data-testid={`setting-${k}`}
            value={draft[k] ?? settings[k]}
            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
            onBlur={() => draft[k] !== undefined && draft[k] !== settings[k] && void save(k, draft[k])}
          />
        </label>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
    </details>
  );
}

/** 规矩页的「仓库现状」标签（设计 §8）：每个仓库已有的检查、建议、可直接用的检查、档案，和标记文件表。 */
export function BaselinePanel() {
  const view = useStateRefetch("baselines", api.baselinesView);
  const lessons = useStateRefetch("baseline-layers", api.lessonsState);
  const settings = useStateRefetch("baseline-infer", api.settings);
  const [msg, setMsg] = useState<Msg>(null);
  const infer = settings?.baselineInfer !== "off";
  const layers = [
    { key: "global", label: S.checksLayerGlobal },
    ...(lessons?.products ?? []).map((p) => ({ key: scopeKey({ kind: "product", productId: p.id }), label: S.policyLayerProduct(p.name) })),
    ...(view?.repos ?? []).map((r) => ({ key: scopeKey({ kind: "repo", slug: r.slug }), label: r.slug })),
  ];
  const scannable = (view?.repos ?? []).filter((r) => r.path && !r.running).map((r) => r.slug);
  return (
    <div className="checks-panel" data-testid="baseline-panel">
      <p className="muted">{S.bl.intro}</p>
      <div className="lessons-row">
        <button className="primary" data-testid="baseline-scan-all" disabled={!scannable.length} onClick={() => void act({ kind: "scan", slugs: scannable, infer, force: true }, setMsg)}>{S.bl.scanAll}</button>
      </div>
      {msg && <p className={msg.error ? "error" : "muted"} role={msg.error ? "alert" : "status"}>{msg.text}</p>}
      <BaselineSettings />
      <RulesEditor layers={layers} />
      {view && view.repos.length === 0 && <p className="muted">{S.lessonsEmpty}</p>}
      {view?.repos.map((r) => <RepoBlock key={r.slug} r={r} infer={infer} />)}
    </div>
  );
}
