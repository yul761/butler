import { useEffect, useState, type FormEvent } from "react";
import { renderBranch } from "../../../shared/branch";
import type { Feature, WorkMode } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { lastSegment } from "../repos";
import { S } from "../strings";
import { RepoPicker } from "./RepoPicker";

interface Props {
  onClose: () => void;
  onCreated: (key: string) => void;
  /** 输入的 ticket 号已经归档时，可以直接恢复它。 */
  onRestored: (key: string) => void;
  /** 建在这个 feature 下：仓库从 feature 的仓库里勾选，worktree 放进 feature 的工作区（设计文档 2026-10-26）。 */
  feature?: Feature;
}

export function NewTicketDialog({ onClose, onCreated, onRestored, feature }: Props) {
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [repoPaths, setRepoPaths] = useState<string[]>(feature?.repos[0] ? [feature.repos[0].repoPath] : []);
  const [workMode, setWorkMode] = useState<WorkMode>("worktree");
  const [branch, setBranch] = useState("");
  const [template, setTemplate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 撞上的已归档 ticket 号（规范化后的，由主进程的报错带回）。 */
  const [archivedKey, setArchivedKey] = useState<string | null>(null);
  const hasRepo = repoPaths.length > 0;

  useEffect(() => {
    api.settings().then((s) => setTemplate(s.branchTemplate), () => setTemplate(null));
  }, []);
  const preview = template && key.trim() ? renderBranch(template, key.trim().toUpperCase(), title) : "feature/PROJ-123";

  async function restore(k: string) {
    try {
      await api.unarchive(k);
      onRestored(k);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setArchivedKey(null);
    try {
      const paths = repoPaths.map((p) => p.trim()).filter(Boolean);
      const t = await api.createTicket({
        key, title, workMode, branch: branch || undefined,
        ...(paths.length > 0 && { repoPaths: paths }),
        ...(feature && { featureId: feature.id }),
      });
      onCreated(t.key);
    } catch (err) {
      setError(err instanceof ButlerError ? (S.createErrors[err.code] ?? err.message) : (err as Error).message);
      if (err instanceof ButlerError && err.code === "archived") setArchivedKey(key.trim().toUpperCase());
    } finally {
      setBusy(false);
    }
  }

  function toggleFeatureRepo(path: string, on: boolean) {
    setRepoPaths(feature!.repos.map((r) => r.repoPath).filter((p) => (p === path ? on : repoPaths.includes(p))));
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>{feature ? S.newTicketIn(feature.name) : S.newTicket}</h2>
        <label>{S.ticketKey}<input value={key} onChange={(e) => { setKey(e.target.value); setArchivedKey(null); }} placeholder="PROJ-123" autoFocus required /></label>
        <label>{S.title}<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        {feature ? (
          <fieldset>
            <legend>{S.pickFeatureRepos}</legend>
            {feature.repos.map((r) => (
              <label key={r.id} className="inline" title={r.repoPath}>
                <input type="checkbox" checked={repoPaths.includes(r.repoPath)} onChange={(e) => toggleFeatureRepo(r.repoPath, e.target.checked)} />
                {lastSegment(r.repoPath)}
              </label>
            ))}
          </fieldset>
        ) : (
          <RepoPicker label={S.repoOptional} onChange={setRepoPaths} />
        )}
        <fieldset disabled={!hasRepo}>
          <legend>{S.workMode}</legend>
          <label className="inline"><input type="radio" checked={workMode === "worktree"} onChange={() => setWorkMode("worktree")} />{S.worktree}</label>
          <label className="inline"><input type="radio" checked={workMode === "branch"} onChange={() => setWorkMode("branch")} />{S.branch}</label>
        </fieldset>
        <label>{S.branchName}<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={preview} disabled={!hasRepo} /></label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          {archivedKey && <button type="button" onClick={() => void restore(archivedKey)}>{S.restoreArchived(archivedKey)}</button>}
          <button type="button" onClick={onClose}>{S.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>{S.create}</button>
        </div>
      </form>
    </div>
  );
}
