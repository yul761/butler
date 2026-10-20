import { useState, type FormEvent } from "react";
import type { WorkMode } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { S } from "../strings";

export function NewTicketDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [workMode, setWorkMode] = useState<WorkMode>("worktree");
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    const dir = await api.pickDirectory();
    if (dir) setRepoPath(dir);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api.createTicket({ key, title, repoPath, workMode, branch: branch || undefined });
      onCreated(t.key);
    } catch (err) {
      setError(err instanceof ButlerError ? (S.createErrors[err.code] ?? err.message) : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>{S.newTicket}</h2>
        <label>{S.ticketKey}<input value={key} onChange={(e) => setKey(e.target.value)} placeholder="PROJ-123" autoFocus required /></label>
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
          <button type="button" onClick={onClose}>{S.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>{S.create}</button>
        </div>
      </form>
    </div>
  );
}
