import { useState, type FormEvent } from "react";
import type { Ticket, WorkMode } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";

/** 编辑 ticket：标题、工作方式、分支。工作方式和分支的改动由主进程检查（有终端在跑、未提交改动时拒绝）。 */
export function EditTicketDialog({ ticket, hasSessions, onClose }: { ticket: Ticket; hasSessions: boolean; onClose: () => void }) {
  const [title, setTitle] = useState(ticket.title ?? "");
  const [workMode, setWorkMode] = useState<WorkMode>(ticket.workMode);
  const [branch, setBranch] = useState(ticket.branch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modeChanged = workMode !== ticket.workMode;
  const branchChanged = branch.trim() !== "" && branch.trim() !== ticket.branch;
  const hint = modeChanged
    ? workMode === "branch" ? S.editModeHint.toBranch : S.editModeHint.toWorktree
    : branchChanged ? S.editModeHint.branch : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateTicket({ key: ticket.key, title, workMode, branch: branch.trim() || undefined });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>{S.editTicket(ticket.key)}</h2>
        <label>{S.titleShort}<input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <div className="muted">{S.repo}：{ticket.repoPath}</div>
        <fieldset>
          <legend>{S.workMode}</legend>
          <label className="inline"><input type="radio" checked={workMode === "worktree"} onChange={() => setWorkMode("worktree")} />{S.worktree}</label>
          <label className="inline"><input type="radio" checked={workMode === "branch"} onChange={() => setWorkMode("branch")} />{S.branch}</label>
        </fieldset>
        <label>{S.branchNameEdit}<input value={branch} onChange={(e) => setBranch(e.target.value)} /></label>
        {hint && <p className="muted">{hint}</p>}
        {hint && hasSessions && <p className="muted">{S.editModeHint.oldSessions}</p>}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>{S.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>{S.save}</button>
        </div>
      </form>
    </div>
  );
}
