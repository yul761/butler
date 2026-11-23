import { useEffect, useState } from "react";
import type { CheckExportAction, CheckExportView, LegacyViolation } from "../../../shared/baselines";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const PAGE = 200;

/** 一次存量扫描的明细，一页 200 处。 */
function Violations({ scanId }: { scanId: number }) {
  const [rows, setRows] = useState<LegacyViolation[] | null>(null);
  const [done, setDone] = useState(false);
  const load = async (offset: number) => {
    try {
      const next = await api.legacyViolations(scanId, offset, PAGE);
      setRows((r) => [...(offset === 0 ? [] : (r ?? [])), ...next]);
      setDone(next.length < PAGE);
    } catch (e) {
      reportError(e);
    }
  };
  useEffect(() => {
    void load(0);
  }, [scanId]);
  if (rows === null) return null;
  if (rows.length === 0) return <p className="muted">{S.legacy.none}</p>;
  return (
    <>
      <ul className="check-hits" data-testid={`legacy-violations-${scanId}`}>
        {rows.map((v, i) => (
          <li key={i} className="check-hit">
            <code>{v.file}{v.line !== null ? `:${v.line}` : ""}</code>
            {v.snippet && <pre className="check-hit-detail">{v.snippet}</pre>}
          </li>
        ))}
      </ul>
      {!done && <button data-testid={`legacy-more-${scanId}`} onClick={() => void load(rows.length)}>{S.legacy.more}</button>}
    </>
  );
}

/** 一条导出记录：分支、文件、改动，推送 / 开 PR / 打开 / 丢弃。 */
function ExportRow({ e, onMsg }: { e: CheckExportView; onMsg(text: string, error: boolean): void }) {
  const [showDiff, setShowDiff] = useState(false);
  const [armed, setArmed] = useState(false);
  const run = async (a: CheckExportAction) => {
    try {
      const r = await api.checkExportAct(a);
      if (r.message) onMsg(r.message, !r.ok);
      else if (!r.ok) onMsg("", true);
    } catch (err) {
      reportError(err);
    }
  };
  const live = e.status === "ready" || e.status === "pushed" || e.status === "pr_opened";
  return (
    <li className="check-hit" data-testid={`export-${e.id}`}>
      <div className="lessons-row">
        <span className={`pill ${e.status === "failed" ? "changes" : e.status === "discarded" ? "none" : "approved"}`} data-testid={`export-status-${e.id}`}>{S.lintExport.status[e.status]}</span>
        <span className="pill none">{S.lintExport.target[e.target]}</span>
        <code>{S.lintExport.branch(e.branch, e.base)}</code>
        {e.status === "ready" && <span className="muted">{e.committed ? S.lintExport.committed : S.lintExport.staged}</span>}
        <span className="muted">{formatTime(e.createdAt)}</span>
      </div>
      {e.files.length > 0 && <p className="muted">{S.lintExport.files}: {e.files.join(", ")}</p>}
      {e.detail && <pre className="check-hit-detail">{e.detail}</pre>}
      {e.prUrl && <p><a href={e.prUrl} target="_blank" rel="noreferrer">{e.prUrl}</a></p>}
      {live && (
        <div className="lessons-row">
          {e.diff && <button data-testid={`export-diff-${e.id}`} onClick={() => setShowDiff(!showDiff)}>{S.lintExport.diff}</button>}
          {e.status === "ready" && <button data-testid={`export-push-${e.id}`} disabled={!e.committed} onClick={() => void run({ kind: "push", id: e.id })}>{S.lintExport.push}</button>}
          {e.status === "pushed" && <button data-testid={`export-pr-${e.id}`} onClick={() => void run({ kind: "pr", id: e.id })}>{S.lintExport.pr}</button>}
          <button data-testid={`export-open-${e.id}`} onClick={() => void run({ kind: "open", id: e.id })}>{S.lintExport.open}</button>
          <button className={armed ? "danger" : undefined} data-testid={`export-discard-${e.id}`} onClick={() => (armed ? void run({ kind: "discard", id: e.id }).then(() => setArmed(false)) : setArmed(true))}>
            {armed ? S.lintExport.discardConfirm : S.lintExport.discard}
          </button>
        </div>
      )}
      {showDiff && <pre className="check-hit-detail" data-testid={`export-diff-text-${e.id}`}>{e.diff}</pre>}
    </li>
  );
}

/**
 * 一条检查在某个仓库上的两个动作（设计 §7、§9）：整个仓库扫一遍存量（「存量 N 处」+ 明细），
 * 和导出成仓库自己的规则（写进 Shipherd 管的 worktree 就停）。
 */
export function CheckRepoTools({ checkId, checkKey, repos, defaultSlug }: { checkId: number; checkKey: string; repos: string[]; defaultSlug: string | null }) {
  const [slug, setSlug] = useState<string>(defaultSlug ?? repos[0] ?? "");
  const scans = useStateRefetch(`legacy-${checkKey}`, api.legacyView);
  const exports = useStateRefetch(`exports-${checkKey}`, api.checkExportList);
  const [showDetail, setShowDetail] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!repos.length) return null;
  const scan = scans?.find((s) => s.checkKey === checkKey && s.slug === slug) ?? null;
  const mine = (exports ?? []).filter((e) => e.checkKey === checkKey && e.slug === slug);
  const startLegacy = async () => {
    try {
      const r = await api.legacyAct({ kind: "run", checkId, slug });
      setMsg(r.ok ? null : { text: r.message, error: true });
      setShowDetail(false);
    } catch (e) {
      reportError(e);
    }
  };
  const runExport = async () => {
    setBusy(true);
    try {
      const r = await api.checkExportAct({ kind: "run", checkKey, slug });
      setMsg(r.message ? { text: r.message, error: !r.ok } : null);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };
  const tid = `${checkKey}`;
  return (
    <div className="field check-repo-tools" data-testid={`check-repo-tools-${tid}`}>
      <div className="lessons-row">
        <label className="inline">
          {S.legacy.repo}
          <select data-testid={`check-repo-${tid}`} value={slug} onChange={(e) => {
              setSlug(e.target.value);
              setShowDetail(false);
              setMsg(null);
            }}
          >
            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        {scan?.status === "running" ? (
          <>
            <span className="muted" role="status" data-testid={`legacy-progress-${tid}`}>{S.legacy.running(scan.filesScanned, scan.filesTotal)}</span>
            <button data-testid={`legacy-cancel-${tid}`} onClick={() => void api.legacyAct({ kind: "cancel", scanId: scan.scanId }).catch(reportError)}>{S.legacy.cancel}</button>
          </>
        ) : (
          <button data-testid={`legacy-run-${tid}`} disabled={!slug} onClick={() => void startLegacy()}>{scan ? S.legacy.rerun : S.legacy.run}</button>
        )}
        <button data-testid={`export-run-${tid}`} title={S.lintExport.runHint} disabled={!slug || busy} onClick={() => void runExport()}>{S.lintExport.run}</button>
      </div>
      {scan && scan.status !== "running" && (
        <div className="lessons-row">
          {scan.status === "failed" ? (
            <span className="error" data-testid={`legacy-count-${tid}`}>{S.legacy.failed(scan.error ?? "")}</span>
          ) : (
            <span className={`pill ${scan.count ? "pending" : "approved"}`} data-testid={`legacy-count-${tid}`}>{scan.status === "truncated" ? S.legacy.truncated(scan.count) : S.legacy.count(scan.count)}</span>
          )}
          {scan.status === "cancelled" && <span className="muted">{S.legacy.status.cancelled}</span>}
          <span className="muted">{S.legacy.at(formatTime(scan.finishedAt ?? scan.startedAt))}</span>
          {scan.count > 0 && <button className="link" data-testid={`legacy-detail-${tid}`} onClick={() => setShowDetail(!showDetail)}>{showDetail ? S.legacy.hide : S.legacy.show}</button>}
        </div>
      )}
      {showDetail && scan && <Violations key={scan.scanId} scanId={scan.scanId} />}
      {msg && msg.text && <p className={msg.error ? "error" : "muted"} role={msg.error ? "alert" : "status"} data-testid={`check-repo-msg-${tid}`}>{msg.text}</p>}
      {mine.length > 0 && (
        <ul className="check-hits" data-testid={`exports-${tid}`}>
          {mine.map((e) => <ExportRow key={e.id} e={e} onMsg={(text, error) => setMsg({ text, error })} />)}
        </ul>
      )}
    </div>
  );
}
