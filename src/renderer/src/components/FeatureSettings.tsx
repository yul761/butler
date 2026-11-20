import { useCallback, useEffect, useRef, useState } from "react";
import { applyFeatureToggle, type FeatureId, type FeaturePolicyState, type FeatureRow } from "../../../shared/feature-rows";
import type { EditableSettings } from "../../../shared/settings";
import type { AdvancedGroupId } from "../../../shared/settings-layout";
import { api } from "../api";
import { reportError } from "../errors";
import { featuresView, runFeatureWrites } from "../feature-toggle";
import { S } from "../strings";

/** hook 事件一来一串：合并成一次重读。 */
const STATE_DEBOUNCE_MS = 80;

function FeatureRowView({ row, busy, onToggle, onOpenAdvanced }: { row: FeatureRow; busy: boolean; onToggle(id: FeatureId, on: boolean): void; onOpenAdvanced(group: AdvancedGroupId): void }) {
  const t = S.set.feat[row.id];
  const { repos, products, differing } = row.otherScopes;
  const others = [repos > 0 ? S.set.otherRepos(repos) : null, products > 0 ? S.set.otherProducts(products) : null].filter((x): x is string => x !== null);
  const elsewhere = differing === 0 ? null : row.state === "off" ? S.set.offButElsewhere(differing) : row.state === "on" ? S.set.onButElsewhere(differing) : null;
  return (
    <div className={`feature-row ${row.state}`} data-testid={`feature-row-${row.id}`} data-state={row.state}>
      <div className="feature-head">
        {row.state === "partial" ? (
          <>
            <span className="feature-title">{t.title}</span>
            <span className="feature-new">{S.set.new3}</span>
            <span className="feature-partial">{S.set.partial(row.on, row.total)}</span>
            <span className="feature-actions">
              <button type="button" data-testid={`feature-all-on-${row.id}`} disabled={busy} onClick={() => onToggle(row.id, true)}>{S.set.allOn}</button>
              <button type="button" data-testid={`feature-all-off-${row.id}`} disabled={busy} onClick={() => onToggle(row.id, false)}>{S.set.allOff}</button>
            </span>
          </>
        ) : (
          <>
            <label className="inline feature-title">
              <input type="checkbox" data-testid={`feature-toggle-${row.id}`} checked={row.state === "on"} disabled={busy} onChange={(e) => onToggle(row.id, e.target.checked)} />
              {t.title}
            </label>
            <span className="feature-new">{S.set.new3}</span>
          </>
        )}
      </div>
      <p className="muted">{t.desc}</p>
      {elsewhere && <p className="feature-elsewhere">{elsewhere}</p>}
      {others.length > 0 && (
        <button type="button" className="link" data-testid={`feature-others-${row.id}`} onClick={() => onOpenAdvanced(row.group)}>
          {others.join(" · ")} · {S.set.openAdvanced}
        </button>
      )}
      {row.needsSetup === "intake_source" && <p className="error" data-testid={`feature-setup-${row.id}`}>{S.set.needsIntakeSource}</p>}
    </div>
  );
}

/** 功能页的纯视图（测试直接渲染它）。busyId：正在写的那一行；写的期间所有行的控件都禁用，免得别的行点了弹回原样。 */
export function FeatureList({ rows, busyId, onToggle, onOpenAdvanced }: { rows: FeatureRow[]; busyId: FeatureId | null; onToggle(id: FeatureId, on: boolean): void; onOpenAdvanced(group: AdvancedGroupId): void }) {
  return (
    <div className="feature-list">
      {rows.map((r) => (
        <FeatureRowView key={r.id} row={r} busy={busyId !== null} onToggle={onToggle} onOpenAdvanced={onOpenAdvanced} />
      ))}
    </div>
  );
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 设置 › 功能：每个 3.0 功能一行。设置和覆盖都读到才画；写的时候不做乐观更新，
 * 写完（成没成都）重读一次，界面总是显示真实状态（免得显示成开、其实只写了一半）。
 */
export function FeatureSettings({ onOpenAdvanced }: { onOpenAdvanced(group: AdvancedGroupId): void }) {
  const [settings, setSettings] = useState<EditableSettings | null>(null);
  const [policy, setPolicy] = useState<FeaturePolicyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<FeatureId | null>(null);
  const seq = useRef(0);
  const live = useRef(true);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const [s, p] = await Promise.allSettled([api.settings(), api.featurePolicy()]);
    if (!live.current || mine !== seq.current) return;
    if (s.status === "rejected" || p.status === "rejected") {
      setError(message(s.status === "rejected" ? s.reason : (p as PromiseRejectedResult).reason));
      return;
    }
    setError(null);
    setSettings(s.value);
    setPolicy(p.value);
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = api.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), STATE_DEBOUNCE_MS);
    });
    return () => {
      live.current = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [load]);

  async function toggle(id: FeatureId, on: boolean) {
    if (busyId) return;
    setBusyId(id);
    const r = await runFeatureWrites(applyFeatureToggle(id, on), (w) =>
      w.kind === "setting" ? api.setSetting(w.key, w.value) : api.policyPatch({ family: w.family, key: w.key, value: w.value }),
    );
    if (!r.ok) reportError(r.error);
    await load();
    if (live.current) setBusyId(null);
  }

  const view = featuresView({ settings, policy, error });
  return (
    <section className="settings-section">
      <p className="muted">{S.set.featuresIntro}</p>
      {view.kind === "loading" && <p className="empty">{S.loading}</p>}
      {view.kind === "failed" && (
        <div className="empty">
          <p className="error">{S.set.featuresFailed}</p>
          <p className="muted">{view.message}</p>
          <button type="button" data-testid="features-retry" onClick={() => void load()}>{S.set.retry}</button>
        </div>
      )}
      {view.kind === "ready" && <FeatureList rows={view.rows} busyId={busyId} onToggle={(id, on) => void toggle(id, on)} onOpenAdvanced={onOpenAdvanced} />}
    </section>
  );
}
