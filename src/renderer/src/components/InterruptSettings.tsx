import { type ReactElement, useCallback, useEffect, useState } from "react";
import { EXTERNAL_ACTION_SETTINGS } from "../../../shared/external";
import { NOTIFY_EVENTS, NOTIFY_FORMATS, type ChoiceDefault, type InterruptsAction, type InterruptsState } from "../../../shared/interrupts";
import type { EditableSettings } from "../../../shared/settings";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { eventsOf, quietValid, toggleEvent } from "../interrupts-view";
import { timeText } from "../lesson-runs-view";
import { S } from "../strings";
import { ProfileCandidates } from "./ProfileCandidates";

type Msg = { text: string; error: boolean } | null;
type FlagKey = "permissionProfiles" | "interruptChoiceRule" | "interruptChoiceDefaults" | "interruptSelfServe" | "notifyDetails";

/** 设置 →「打断与通知」（工作流 J）：权限档案、选择题（规则、默认答案、复查）、缺信息自助、外部通知。 */
export function InterruptSettings() {
  const [state, setState] = useState<InterruptsState | null>(null);
  const [settings, setSettings] = useState<EditableSettings | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const load = useCallback(async () => {
    try {
      const [st, s] = await Promise.all([api.interruptsState(), api.settings()]);
      setState(st);
      setSettings(s);
    } catch (e) {
      reportError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  const fail = (e: unknown) => {
    if (e instanceof ButlerError) setMsg({ text: e.message, error: true });
    else reportError(e);
  };
  const act = async (a: InterruptsAction) => {
    setMsg(null);
    try {
      const r = await api.interruptsAct(a);
      setState(r.state);
      return r;
    } catch (e) {
      fail(e);
      return null;
    }
  };
  const set = async (key: keyof EditableSettings, value: string) => {
    setMsg(null);
    try {
      await api.setSetting(key, value);
      setSettings(await api.settings());
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  if (!state || !settings) return <p className="empty">{S.loading}</p>;
  const flag = (key: FlagKey, label: string) => (
    <label className="inline field-row">
      <input type="checkbox" data-testid={`ij-${key}`} checked={settings[key] === "1"} onChange={(e) => void set(key, e.target.checked ? "1" : "0")} />
      {label}
    </label>
  );

  const pending = state.profiles.filter((r) => r.status === "pending");
  const decided = state.profiles.filter((r) => r.status !== "pending");

  return (
    <section className="interrupt-settings" data-testid="interrupt-settings">
      <h2>{S.ij.heading}</h2>
      <p className="muted">{S.ij.intro}</p>
      {msg && <p className={msg.error ? "error" : "muted"}>{msg.text}</p>}

      <h3>{S.ij.profileHeading}</h3>
      <p className="muted">{S.ij.profileIntro}</p>
      {flag("permissionProfiles", S.ij.profileSwitch)}
      <ProfileCandidates onDecided={() => void load()} />
      {pending.length > 0 && (
        <>
          <h4>{S.ij.pendingHeading}</h4>
          <ul className="plain" data-testid="profile-pending">
            {pending.map((r) => (
              <li key={`${r.slug}\n${r.rule}`}>
                <span className="mono">{r.rule}</span> <span className="muted">{r.slug}</span>{" "}
                <button onClick={() => void act({ op: "profile_decide", slug: r.slug, confirm: [r.rule], dismiss: [] })}>{S.ij.confirm}</button>{" "}
                <button onClick={() => void act({ op: "profile_remove", slug: r.slug, rule: r.rule })}>{S.ij.remove}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {decided.length > 0 && (
        <>
          <h4>{S.ij.decidedHeading}</h4>
          <ul className="plain" data-testid="profile-decided">
            {decided.map((r) => (
              <li key={`${r.slug}\n${r.rule}`} data-testid={`profile-rule-${r.rule}`}>
                <span className="mono">{r.rule}</span> <span className="muted">{r.slug} · {S.ij.statusLabel[r.status]}</span>{" "}
                <button onClick={() => void act({ op: "profile_remove", slug: r.slug, rule: r.rule })}>{S.ij.remove}</button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>{S.ij.choicesHeading}</h3>
      {flag("interruptChoiceRule", S.ij.choiceRule)}
      {flag("interruptChoiceDefaults", S.ij.choiceDefaults)}
      {flag("interruptSelfServe", S.ij.selfServe)}
      <DefaultsEditor defaults={state.defaults} act={act} />
      <h4>{S.ij.autoHeading} {state.unreviewed > 0 && <span className="badge">{S.ij.autoUnreviewed(state.unreviewed)}</span>}</h4>
      {state.autoChoices.length === 0 ? (
        <p className="empty">{S.ij.noAuto}</p>
      ) : (
        <>
          {state.unreviewed > 0 && (
            <div className="actions">
              <button onClick={() => void act({ op: "choices_review", ids: null })}>{S.ij.markAllReviewed}</button>
            </div>
          )}
          <ul className="plain auto-choices" data-testid="auto-choices">
            {state.autoChoices.map((c) => (
              <li key={c.id} className={c.reviewedAt ? "muted" : undefined}>
                <span className="muted">{timeText(c.createdAt)} · {S.ij.autoSource[c.source]}{c.ticketKey ? ` · ${c.ticketKey}` : ""}</span>
                <div className="pre-wrap">{c.text}</div>
                {!c.reviewedAt && <button onClick={() => void act({ op: "choices_review", ids: [c.id] })}>{S.ij.markReviewed}</button>}
              </li>
            ))}
          </ul>
        </>
      )}

      <NotifySection state={state} settings={settings} act={act} set={set} flag={flag} />
    </section>
  );
}

function DefaultsEditor({ defaults, act }: { defaults: ChoiceDefault[]; act: (a: InterruptsAction) => Promise<unknown> }) {
  const [drafts, setDrafts] = useState<Record<number, { pattern: string; answer: string; enabled: boolean }>>({});
  const [fresh, setFresh] = useState({ pattern: "", answer: "" });
  const row = (d: ChoiceDefault) => drafts[d.id] ?? { pattern: d.pattern, answer: d.answer, enabled: d.enabled };
  const edit = (d: ChoiceDefault, patch: Partial<{ pattern: string; answer: string; enabled: boolean }>) => setDrafts({ ...drafts, [d.id]: { ...row(d), ...patch } });
  const drop = (id: number) => {
    const next = { ...drafts };
    delete next[id];
    setDrafts(next);
  };

  return (
    <div className="choice-defaults" data-testid="choice-defaults">
      <h4>{S.ij.defaultsHeading}</h4>
      <p className="muted">{S.ij.defaultsIntro}</p>
      {defaults.length === 0 && <p className="empty">{S.ij.noDefaults}</p>}
      {defaults.map((d) => {
        const r = row(d);
        const dirty = drafts[d.id] !== undefined;
        return (
          <div key={d.id} className="field-row">
            <input aria-label={S.ij.pattern} value={r.pattern} onChange={(e) => edit(d, { pattern: e.target.value })} />
            <input aria-label={S.ij.answer} placeholder={S.ij.answerPlaceholder} value={r.answer} onChange={(e) => edit(d, { answer: e.target.value })} />
            <label className="inline">
              <input type="checkbox" checked={r.enabled} onChange={(e) => edit(d, { enabled: e.target.checked })} />
              {S.ij.enabled}
            </label>
            <button disabled={!dirty || r.pattern.trim() === ""} onClick={() => void act({ op: "default_save", id: d.id, ...r }).then((res) => res && drop(d.id))}>{S.ij.save}</button>
            <button onClick={() => void act({ op: "default_delete", id: d.id }).then((res) => res && drop(d.id))}>{S.ij.del}</button>
          </div>
        );
      })}
      <div className="field-row">
        <input aria-label={S.ij.pattern} data-testid="default-new-pattern" placeholder={S.ij.pattern} value={fresh.pattern} onChange={(e) => setFresh({ ...fresh, pattern: e.target.value })} />
        <input aria-label={S.ij.answer} placeholder={S.ij.answerPlaceholder} value={fresh.answer} onChange={(e) => setFresh({ ...fresh, answer: e.target.value })} />
        <button
          disabled={fresh.pattern.trim() === ""}
          onClick={() => void act({ op: "default_save", id: null, pattern: fresh.pattern, answer: fresh.answer, enabled: true }).then((r) => r && setFresh({ pattern: "", answer: "" }))}
        >
          {S.ij.add}
        </button>
      </div>
    </div>
  );
}

function NotifySection(p: {
  state: InterruptsState;
  settings: EditableSettings;
  act: (a: InterruptsAction) => Promise<{ test?: { ok: boolean; error: string | null } } | null>;
  set: (key: keyof EditableSettings, value: string) => Promise<boolean>;
  flag: (key: FlagKey, label: string) => ReactElement;
}) {
  const { state, settings, act, set, flag } = p;
  const [url, setUrl] = useState("");
  const [quiet, setQuiet] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const on = settings[EXTERNAL_ACTION_SETTINGS.push_notification] === "1";
  const wh = state.webhook;
  const events = eventsOf(settings.notifyEvents);
  const quietText = quiet ?? settings.notifyQuietHours;

  return (
    <div className="notify-settings" data-testid="notify-settings">
      <h3>{S.ij.notifyHeading}</h3>
      <p className="muted">{S.ij.notifyIntro}</p>
      <p className={on ? "ok" : "muted"} data-testid="notify-switch">{on ? S.ij.notifySwitchOn : S.ij.notifySwitchOff}</p>
      <div className="field">
        {S.ij.webhook}
        {wh.saved && <p className="muted" data-testid="webhook-saved">{wh.unreadable ? S.ij.webhookUnreadable : S.ij.webhookSaved(wh.host ?? "?")}</p>}
        <div className="field-row">
          <input className="mono" type="password" autoComplete="off" data-testid="webhook-url" placeholder={S.ij.webhookPlaceholder} value={url} onChange={(e) => setUrl(e.target.value)} />
          <button disabled={url.trim() === ""} onClick={() => void act({ op: "webhook_save", url: url.trim() }).then((r) => r && setUrl(""))}>{S.ij.save}</button>
          {wh.saved && <button onClick={() => void act({ op: "webhook_clear" })}>{S.ij.clear}</button>}
        </div>
      </div>
      <label className="field">
        {S.ij.format}
        <select value={settings.notifyFormat} onChange={(e) => void set("notifyFormat", e.target.value)}>
          {NOTIFY_FORMATS.map((f) => <option key={f} value={f}>{S.ij.formatLabel[f]}</option>)}
        </select>
      </label>
      <div className="field">
        {S.ij.events}
        {NOTIFY_EVENTS.map((ev) => (
          <label key={ev} className="inline field-row">
            <input type="checkbox" data-testid={`notify-event-${ev}`} checked={events.includes(ev)} onChange={(e) => void set("notifyEvents", toggleEvent(settings.notifyEvents, ev, e.target.checked))} />
            {S.ij.eventLabel[ev]}
          </label>
        ))}
      </div>
      {flag("notifyDetails", S.ij.details)}
      <div className="field">
        {S.ij.quiet}
        <div className="field-row">
          <input className="mono" data-testid="notify-quiet" placeholder={S.ij.quietPlaceholder} value={quietText} onChange={(e) => setQuiet(e.target.value)} />
          <button disabled={quiet === null || !quietValid(quiet)} onClick={() => void set("notifyQuietHours", quietText).then((ok) => ok && setQuiet(null))}>{S.ij.save}</button>
        </div>
        <p className="muted">{S.ij.quietHint}</p>
      </div>
      <div className="actions">
        <button
          data-testid="notify-test"
          disabled={!wh.saved}
          onClick={() => {
            setTest(null);
            void act({ op: "notify_test" }).then((r) => r?.test && setTest(r.test.ok ? S.ij.testOk : S.ij.testFailed(r.test.error ?? "")));
          }}
        >
          {S.ij.test}
        </button>
        {test && <span className="muted"> {test}</span>}
      </div>
      <h4>{S.ij.logHeading}</h4>
      {state.log.length === 0 ? (
        <p className="empty">{S.ij.noLog}</p>
      ) : (
        <table className="notify-log" data-testid="notify-log">
          <tbody>
            {state.log.map((e) => (
              <tr key={e.id} className={`notify-${e.status}`}>
                <td>{timeText(e.ts)}</td>
                <td>{S.ij.eventLabel[e.event]}</td>
                <td>{S.ij.logCount(e.count)}</td>
                <td>{S.ij.logStatus[e.status]}</td>
                <td className="muted">{e.host ?? ""}{e.error ? ` · ${e.error}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
