import { useEffect, useState } from "react";
import type { ProfileScan } from "../../../shared/interrupts";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { defaultPicks, groupCandidates, pickKey } from "../interrupts-view";
import { timeText } from "../lesson-runs-view";
import { S } from "../strings";

/**
 * 权限档案的候选（ws-j 设计 2）：向导和设置页共用。还没扫过就先扫一次；勾上的确认，其余可以「不再提」。
 * 候选都来自本机的 transcript，主进程已经用 isSafeRule 过滤过，确认时还会再查一次。
 */
export function ProfileCandidates({ onDecided }: { onDecided?: () => void }) {
  const [scan, setScan] = useState<ProfileScan | null>(null);
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"scan" | "explain" | "decide" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const take = (s: ProfileScan) => {
    setScan(s);
    setPicks(defaultPicks(s.candidates));
  };
  const run = async (kind: "scan" | "explain") => {
    setBusy(kind);
    setError(null);
    try {
      take(await api.profilesScan(kind === "explain"));
    } catch (e) {
      if (e instanceof ButlerError) setError(e.message);
      else reportError(e);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    let live = true;
    api.profilesGet().then((s) => {
      if (!live) return;
      if (s.scannedAt === null) void run("scan");
      else take(s);
    }, reportError);
    return () => {
      live = false;
    };
  }, []);

  const decide = async (slug: string, confirm: string[], dismiss: string[]) => {
    setBusy("decide");
    setError(null);
    try {
      await api.interruptsAct({ op: "profile_decide", slug, confirm, dismiss });
      take(await api.profilesGet());
      onDecided?.();
    } catch (e) {
      if (e instanceof ButlerError) setError(e.message);
      else reportError(e);
    } finally {
      setBusy(null);
    }
  };

  const groups = groupCandidates(scan?.candidates ?? []);
  const toggle = (k: string, on: boolean) => {
    const next = new Set(picks);
    if (on) next.add(k);
    else next.delete(k);
    setPicks(next);
  };

  return (
    <div className="profile-candidates" data-testid="profile-candidates">
      <p className="muted">
        {busy === "scan" ? S.ij.scanning : scan?.scannedAt ? S.ij.scannedAt(timeText(scan.scannedAt)) : S.ij.notScanned}
      </p>
      <div className="actions">
        <button disabled={busy !== null} data-testid="profile-scan" onClick={() => void run("scan")}>{S.ij.scan}</button>
        <button disabled={busy !== null || groups.length === 0} onClick={() => void run("explain")}>{busy === "explain" ? S.ij.explaining : S.ij.explain}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {scan && groups.length === 0 && busy !== "scan" && <p className="empty">{S.ij.noCandidates}</p>}
      {groups.map((g) => {
        const picked = g.items.filter((i) => picks.has(pickKey(g.slug, i.rule))).map((i) => i.rule);
        const rest = g.items.filter((i) => !picks.has(pickKey(g.slug, i.rule))).map((i) => i.rule);
        return (
          <div key={g.slug} className="profile-repo" data-testid={`profile-repo-${g.slug}`}>
            <h4 className="mono">{g.slug}</h4>
            <ul className="plain">
              {g.items.map((i) => {
                const k = pickKey(g.slug, i.rule);
                return (
                  <li key={k}>
                    <label className="inline">
                      <input type="checkbox" data-testid={`profile-pick-${i.rule}`} checked={picks.has(k)} onChange={(e) => toggle(k, e.target.checked)} />
                      <span className="mono">{i.rule}</span>
                    </label>
                    <span className="muted"> {S.ij.runs(i.runs, i.sessions)} · {S.ij.example(i.example)}</span>
                    {i.caution && <span className="error"> {S.ij.caution}</span>}
                    {i.why && <div className="muted">{i.why}</div>}
                  </li>
                );
              })}
            </ul>
            <div className="actions">
              <button className="primary" data-testid={`profile-confirm-${g.slug}`} disabled={busy !== null || picked.length === 0} onClick={() => void decide(g.slug, picked, [])}>
                {S.ij.confirmPicked}
              </button>
              <button disabled={busy !== null || rest.length === 0} onClick={() => void decide(g.slug, [], rest)}>{S.ij.dismiss}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
