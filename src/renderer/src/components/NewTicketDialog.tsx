import { useState, type FormEvent } from "react";
import type { WorkMode } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";

interface Props {
  onClose: () => void;
  onCreated: (key: string) => void;
  /** 输入的 ticket 号已经归档时，可以直接恢复它。 */
  onRestored: (key: string) => void;
}

export function NewTicketDialog({ onClose, onCreated, onRestored }: Props) {
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [workMode, setWorkMode] = useState<WorkMode>("worktree");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 撞上的已归档 ticket 号（规范化后的，由主进程的报错带回）。 */
  const [archivedKey, setArchivedKey] = useState<string | null>(null);

  async function pick() {
    try {
      const dir = await api.pickDirectory();
      if (dir) setRepoPath(dir);
    } catch (e) {
      reportError(e);
    }
  }

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
      const t = await api.createTicket({ key, title, repoPath, workMode, branch: branch || undefined });
      onCreated(t.key);
    } catch (err) {
      setError(err instanceof ButlerError ? (S.createErrors[err.code] ?? err.message) : (err as Error).message);
      if (err instanceof ButlerError && err.code === "archived") setArchivedKey(key.trim().toUpperCase());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>{S.newTicket}</h2>
        <label>{S.ticketKey}<input value={key} onChange={(e) => { setKey(e.target.value); setArchivedKey(null); }} placeholder="PROJ-123" autoFocus required /></label>
        <label>{S.title}<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>
          {S.repo}
          <div className="row">
            <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} required />
            <button type="button" onClick={pick}>{S.pick}</button>
          </div>
        </label>
        <fieldset>
          <legend>{S.workMode}</legend>
          <label className="inline"><input type="radio" checked={workMode === "worktree"} onChange={() => setWorkMode("worktree")} />{S.worktree}</label>
          <label className="inline"><input type="radio" checked={workMode === "branch"} onChange={() => setWorkMode("branch")} />{S.branch}</label>
        </fieldset>
        <label>{S.branchName}<input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feature/PROJ-123" /></label>
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
