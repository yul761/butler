import { useState } from "react";
import type {
  ConfigIoStatus, ExportContent, ExportRequest, ExportScopeArg, ImportApplyResult, ImportMode, ImportPreview, PreviewRow, Resolution, SectionPreview, StarterTarget,
} from "../../../shared/config-io";
import { EXPORT_CONTENTS, PREVIEW_STATUSES } from "../../../shared/config-io";
import type { LessonsState } from "../../../shared/lessons";
import { api } from "../api";
import { reportError } from "../errors";
import { applyBulkResolution, backupKind, confirmsLesson, diffValue, effectiveResolution, formatKb, resolutionKey, rowChoosable } from "../lessons-bulk-view";
import { S } from "../strings";
import { BatchNotice, type BatchNoticeState } from "./LessonBulkBar";
import { useStateRefetch } from "./useStateRefetch";

const formatTime = (ms: number) => new Date(ms).toLocaleString([], { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const STATUS_PILL: Record<string, string> = { added: "approved", changed: "merged", conflicting: "changes", unchanged: "none", removed: "pending" };

/** 下拉框里的范围值：all / product:<id> / repo:<slug>。 */
function scopeArg(v: string): ExportScopeArg {
  if (v.startsWith("product:")) return { kind: "product", productId: Number(v.slice(8)) };
  if (v.startsWith("repo:")) return { kind: "repo", slug: v.slice(5) };
  return { kind: "all" };
}
function targetArg(v: string): StarterTarget | null {
  if (v.startsWith("product:")) return { kind: "product", productId: Number(v.slice(8)) };
  if (v.startsWith("repo:")) return { kind: "repo", slug: v.slice(5) };
  return null;
}

function ScopeOptions({ s }: { s: LessonsState }) {
  return (
    <>
      {s.products.map((p) => <option key={`p${p.id}`} value={`product:${p.id}`}>{S.ioScopeProduct(p.name)}</option>)}
      {s.repos.map((r) => <option key={`r${r.slug}`} value={`repo:${r.slug}`}>{S.ioScopeRepo(r.slug)}</option>)}
    </>
  );
}

function ExportForm({ s, checksAvailable }: { s: LessonsState; checksAvailable: boolean }) {
  const [scope, setScope] = useState("all");
  const [content, setContent] = useState<ExportContent>("all");
  const [urls, setUrls] = useState(false);
  const [starter, setStarter] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const run = async () => {
    const req: ExportRequest = { scope: scopeArg(scope), options: { content: starter ? "lessons" : content, includeSourceUrls: starter ? false : urls } };
    if (starter) req.starter = { name: name.trim() };
    setBusy(true);
    try {
      const r = await api.configExport(req);
      if (r.ok) setMessage({ text: S.ioExported(r.file), error: false });
      else if (r.reason !== "cancelled") setMessage({ text: S.ioExportError[r.reason] ?? S.lessonsErrorGeneric, error: true });
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="config-io-export" data-testid="io-export-form">
      <h3>{S.ioExportTitle}</h3>
      <div className="lessons-row">
        <label className="inline">
          {S.ioScope}
          <select data-testid="io-export-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">{S.ioScopeAll}</option>
            <ScopeOptions s={s} />
          </select>
        </label>
        <label className="inline">
          {S.ioContent}
          <select data-testid="io-export-content" value={starter ? "lessons" : content} disabled={starter} onChange={(e) => setContent(e.target.value as ExportContent)}>
            {EXPORT_CONTENTS.map((c) => <option key={c} value={c} disabled={c === "checks" && !checksAvailable}>{S.ioContentLabel[c]}</option>)}
          </select>
        </label>
      </div>
      {!checksAvailable && <p className="muted">{S.ioChecksUnavailable}</p>}
      <label className="inline">
        <input type="checkbox" data-testid="io-export-urls" checked={urls && !starter} disabled={starter} onChange={(e) => setUrls(e.target.checked)} />
        {S.ioIncludeUrls}
      </label>
      <label className="inline">
        <input type="checkbox" data-testid="io-export-starter" checked={starter} onChange={(e) => setStarter(e.target.checked)} />
        {S.ioStarter}
      </label>
      {starter && <input data-testid="io-export-starter-name" aria-label={S.ioStarterName} placeholder={S.ioStarterName} value={name} onChange={(e) => setName(e.target.value)} />}
      <div className="lessons-row">
        <button className="primary" data-testid="io-export" disabled={busy || (starter && !name.trim())} onClick={() => void run()}>{S.ioExport}</button>
      </div>
      {message && <p className={message.error ? "error" : "muted"} role={message.error ? "alert" : "status"} data-testid="io-export-message">{message.text}</p>}
    </section>
  );
}

function PreviewSection({ section, mode, bulk, resolutions, onResolve }: {
  section: SectionPreview; mode: ImportMode; bulk: Resolution | undefined; resolutions: Record<string, Resolution>; onResolve(key: string, r: Resolution): void;
}) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const label = S.ioSection[section.id] ?? section.id;
  const rows = section.rows.filter((r) => showUnchanged || r.status !== "unchanged");
  const row = (r: PreviewRow) => {
    const key = resolutionKey(section.id, r.fingerprint);
    const choice = effectiveResolution(section.id, r, mode, bulk, resolutions);
    return (
      <li key={key} className="config-io-row" data-testid={`io-row-${section.id}-${r.fingerprint}`}>
        <div className="lessons-row">
          <span className={`pill ${STATUS_PILL[r.status]}`}>{S.previewStatus[r.status]}</span>
          <span className="lesson-text">{r.label}</span>
          {confirmsLesson(section.id, r, choice) && <span className="pill changes" data-testid={`io-confirms-${r.fingerprint}`} title={S.ioWillConfirmTitle}>{S.ioWillConfirm}</span>}
        </div>
        {r.diffs.length > 0 && (
          <ul className="config-io-diffs muted">
            {r.diffs.map((d) => (
              <li key={d.field}>{S.ioDiffField[d.field] ?? d.field}：{S.ioLocal} {diffValue(d.local, S.batchNone)} · {S.ioIncoming} {diffValue(d.incoming, S.batchNone)}</li>
            ))}
          </ul>
        )}
        {r.relatedId != null && <p className="muted">{S.ioRelated(r.relatedId)}</p>}
        {r.relatedId != null && r.reasons.length > 0 && <p className="muted">{r.reasons.join(" · ")}</p>}
        {r.status === "removed" && mode === "merge" && <p className="muted">{S.ioRemovedMergeNote}</p>}
        {rowChoosable(r, mode) && (
          <div className="lessons-row" role="radiogroup">
            <label className="inline">
              <input type="radio" name={key} data-testid={`io-pick-imported-${section.id}-${r.fingerprint}`} checked={choice === "imported"} onChange={() => onResolve(key, "imported")} />
              {r.status === "removed" ? S.ioDeleteLocal : S.ioUseImported}
            </label>
            <label className="inline">
              <input type="radio" name={key} data-testid={`io-pick-local-${section.id}-${r.fingerprint}`} checked={choice === "local"} onChange={() => onResolve(key, "local")} />
              {S.ioKeepLocal}
            </label>
          </div>
        )}
      </li>
    );
  };
  return (
    <div className="config-io-section" data-testid={`io-section-${section.id}`}>
      <h4>{label}</h4>
      <p className="muted" data-testid={`io-counts-${section.id}`}>
        {PREVIEW_STATUSES.filter((st) => section.counts[st] > 0).map((st) => S.ioCount(S.previewStatus[st], section.counts[st])).join(" · ") || S.previewStatus.unchanged}
      </p>
      <ul className="config-io-rows">{rows.map(row)}</ul>
      {section.counts.unchanged > 0 && (
        <button className="link" onClick={() => setShowUnchanged((v) => !v)}>{showUnchanged ? S.ioHideUnchanged : S.ioShowUnchanged(section.counts.unchanged)}</button>
      )}
    </div>
  );
}

function ImportFlow({ s }: { s: LessonsState }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [bulk, setBulk] = useState<Resolution | undefined>(undefined);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Extract<ImportApplyResult, { ok: true }> | null>(null);
  const [notice, setNotice] = useState<BatchNoticeState | null>(null);

  const reset = () => {
    setPreview(null);
    setMode("merge");
    setBulk(undefined);
    setResolutions({});
    setTarget("");
  };
  const previewFailed = (reason: string, section?: string) =>
    setError(reason === "bad_section" && section ? S.ioPreviewBadSection(section) : (S.ioPreviewError[reason] ?? S.lessonsErrorGeneric));

  const choose = async () => {
    setBusy(true);
    try {
      const r = await api.configImportPreview();
      if (r.ok) {
        reset();
        setPreview(r.preview);
        setError(null);
        setResult(null);
        setNotice(null);
      } else if (r.reason !== "cancelled") previewFailed(r.reason, r.section);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const retarget = async (v: string) => {
    setTarget(v);
    const t = targetArg(v);
    if (!preview || !t) return;
    try {
      const r = await api.configImportRetarget(preview.token, t);
      if (r.ok) {
        setPreview(r.preview);
        setResolutions({});
        setError(null);
      } else previewFailed(r.reason, r.section);
    } catch (e) {
      reportError(e);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await api.configImportApply({ token: preview.token, mode, ...(bulk ? { bulk } : {}), resolutions });
      if (!r.ok) {
        setError(S.ioApplyError[r.reason] ?? S.lessonsErrorGeneric);
        if (r.reason === "expired") reset();
        return;
      }
      setError(null);
      setResult(r);
      setNotice({ batchId: r.batchId, text: S.ioApplied });
      reset();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const pickAll = (choice: Resolution) => {
    if (!preview) return;
    setBulk(choice);
    setResolutions(applyBulkResolution(preview, mode, choice));
  };
  const switchMode = (m: ImportMode) => {
    setMode(m);
    setResolutions({});
    setBulk(undefined);
  };

  const needsTarget = !!preview?.starter && !targetArg(target);
  return (
    <section className="config-io-import" data-testid="io-import">
      <h3>{S.ioImportTitle}</h3>
      <div className="lessons-row">
        <button data-testid="io-choose" disabled={busy} onClick={() => void choose()}>{S.ioChooseFile}</button>
        {preview && <button data-testid="io-cancel" onClick={reset}>{S.ioCancel}</button>}
      </div>
      {error && <p className="error" role="alert" data-testid="io-error">{error}</p>}
      {notice && <BatchNotice notice={notice} onChange={setNotice} />}
      {result && (
        <div className="config-io-result" data-testid="io-result">
          {Object.entries(result.sections).map(([id, c]) => <p key={id} className="muted">{S.ioAppliedCounts(S.ioSection[id] ?? id, c)}</p>)}
          {(result.sections.lessons?.added ?? 0) > 0 && <p className="muted">{S.ioAppliedPending}</p>}
          {result.backupFile && <p className="muted" data-testid="io-backup-file">{S.ioBackupWritten(result.backupFile.split(/[\\/]/).pop() ?? result.backupFile)}</p>}
        </div>
      )}
      {preview && (
        <div className="config-io-preview" data-testid="io-preview">
          <p className="muted">
            {S.ioFileInfo(preview.file.butlerVersion, formatTime(preview.file.exportedAt))} · {S.ioFileScope(preview.file.scope)}
            {preview.file.includeSourceUrls && <> · {S.ioFileHasUrls}</>}
          </p>
          {preview.skippedSections.length > 0 && <p className="muted" data-testid="io-skipped">{S.ioSkipped(preview.skippedSections)}</p>}
          {preview.starter && (
            <label className="inline">
              {S.ioStarterTarget}
              <select data-testid="io-target" value={target} onChange={(e) => void retarget(e.target.value)}>
                <option value="">{S.ioStarterPick}</option>
                <ScopeOptions s={s} />
              </select>
            </label>
          )}
          <p className="muted" data-testid="io-totals">
            {PREVIEW_STATUSES.filter((st) => preview.totals[st] > 0).map((st) => S.ioCount(S.previewStatus[st], preview.totals[st])).join(" · ")}
          </p>
          <fieldset className="config-io-mode">
            <legend>{S.ioMode}</legend>
            <label className="inline">
              <input type="radio" name="io-mode" data-testid="io-mode-merge" checked={mode === "merge"} onChange={() => switchMode("merge")} />
              {S.ioModeMerge}
            </label>
            <label className="inline">
              <input type="radio" name="io-mode" data-testid="io-mode-replace" checked={mode === "replace"} disabled={preview.starter} onChange={() => switchMode("replace")} />
              {S.ioModeReplace}
            </label>
            {preview.starter && <p className="muted">{S.ioStarterMergeOnly}</p>}
          </fieldset>
          <div className="lessons-row">
            <button data-testid="io-all-imported" onClick={() => pickAll("imported")}>{S.ioAllImported}</button>
            <button data-testid="io-all-local" onClick={() => pickAll("local")}>{S.ioAllLocal}</button>
          </div>
          {preview.sections.map((sec) => (
            <PreviewSection key={sec.id} section={sec} mode={mode} bulk={bulk} resolutions={resolutions} onResolve={(k, r) => setResolutions((x) => ({ ...x, [k]: r }))} />
          ))}
          <div className="lessons-row">
            <button className="primary" data-testid="io-apply" disabled={busy || needsTarget} onClick={() => void apply()}>{S.ioApply}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function Backups({ status }: { status: ConfigIoStatus }) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const backupNow = async () => {
    try {
      const r = await api.configBackupNow();
      setMessage(r.ok ? { text: S.ioBackupDone(r.name), error: false } : { text: S.ioBackupFailed, error: true });
    } catch (e) {
      reportError(e);
    }
  };
  return (
    <section className="config-io-backups" data-testid="io-backups">
      {status.remind && <p className="lessons-suggest" role="status" data-testid="io-reminder">{S.ioReminder(status.reminderDays)}</p>}
      <p className="muted">
        {S.ioLastExport(status.lastExportAt === null ? S.ioNever : formatTime(status.lastExportAt))} · {S.ioLastBackup(status.lastBackupAt === null ? S.ioNever : formatTime(status.lastBackupAt))}
      </p>
      <h3>{S.ioBackupsTitle}</h3>
      <p className="muted">{S.ioBackupAuto(status.intervalDays, status.keep)} {S.ioBackupDir(status.backupDir)}</p>
      <div className="lessons-row">
        <button data-testid="io-backup-now" onClick={() => void backupNow()}>{S.ioBackupNow}</button>
        <button data-testid="io-open-backups" onClick={() => void api.configOpenBackups().catch(reportError)}>{S.ioOpenBackups}</button>
      </div>
      {message && <p className={message.error ? "error" : "muted"} role={message.error ? "alert" : "status"} data-testid="io-backup-message">{message.text}</p>}
      {status.backups.length === 0 ? (
        <p className="muted">{S.ioNoBackups}</p>
      ) : (
        <ul className="lesson-run-list" data-testid="io-backup-list">
          {status.backups.map((b) => (
            <li key={b.name} className="lesson-run">
              <span className="pill none">{S.ioBackupKind[backupKind(b.name)]}</span>
              <span>{formatTime(b.at)}</span>
              <span className="muted"> · {S.ioSize(formatKb(b.size))} · {b.name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 导入导出标签页（契约 4.3）。 */
export function ConfigIoPanel({ s }: { s: LessonsState }) {
  const status = useStateRefetch("config-status", api.configStatus);
  const checksAvailable = !!status?.sections.some((x) => x.content === "checks");
  return (
    <div className="config-io" data-testid="config-io">
      <h3>{S.ioTitle}</h3>
      <p className="muted">{S.ioIntro}</p>
      {status && <Backups status={status} />}
      <ExportForm s={s} checksAvailable={checksAvailable} />
      <ImportFlow s={s} />
    </div>
  );
}
