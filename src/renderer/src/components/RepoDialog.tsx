import { useState, type FormEvent } from "react";
import type { TicketRepo, WorkMode } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { repoName } from "../repos";
import { RepoPicker } from "./RepoPicker";
import { S } from "../strings";

interface Props {
  ticketKey: string;
  /** 给出时编辑这个仓库的工作方式和分支；省略时添加新仓库。 */
  repo?: TicketRepo;
  hasSessions: boolean;
  onClose: () => void;
}

/** 添加仓库，或者改一个仓库的工作方式和分支。git 的改动由主进程检查（有终端在跑、未提交改动时拒绝）。 */
export function RepoDialog({ ticketKey, repo, hasSessions, onClose }: Props) {
  /** 添加时要加的仓库：选了上一层目录就是勾选的那几个（设计文档 2026-10-26）。 */
  const [repoPaths, setRepoPaths] = useState<string[]>([]);
  const [workMode, setWorkMode] = useState<WorkMode>(repo?.workMode ?? "worktree");
  const [branch, setBranch] = useState(repo?.branch ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modeChanged = repo !== undefined && workMode !== repo.workMode;
  const branchChanged = repo !== undefined && branch.trim() !== "" && branch.trim() !== repo.branch;
  const hint = modeChanged
    ? workMode === "branch" ? S.editModeHint.toBranch : S.editModeHint.toWorktree
    : branchChanged ? S.editModeHint.branch : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (repo) await api.updateRepo({ repoId: repo.id, workMode, branch: branch.trim() || undefined });
      else for (const repoPath of repoPaths) await api.addRepo({ ticketKey, repoPath, workMode, branch: branch.trim() || undefined });
      onClose();
    } catch (err) {
      setError(err instanceof ButlerError ? (S.createErrors[err.code] ?? err.message) : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>{repo ? S.editRepoTitle(repoName(repo)) : S.addRepoTitle(ticketKey)}</h2>
        {repo ? (
          <div className="muted">{S.labelled(S.repo, repo.repoPath)}</div>
        ) : (
          <RepoPicker label={S.repo} onChange={setRepoPaths} required autoFocus />
        )}
        <fieldset>
          <legend>{S.workMode}</legend>
          <label className="inline"><input type="radio" checked={workMode === "worktree"} onChange={() => setWorkMode("worktree")} />{S.worktree}</label>
          <label className="inline"><input type="radio" checked={workMode === "branch"} onChange={() => setWorkMode("branch")} />{S.branch}</label>
        </fieldset>
        <label>
          {repo ? S.branchNameEdit : S.branchName}
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={repo ? undefined : `feature/${ticketKey}`} />
        </label>
        {hint && <p className="muted">{hint}</p>}
        {hint && hasSessions && <p className="muted">{S.editModeHint.oldSessions}</p>}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>{S.cancel}</button>
          <button type="submit" className="primary" disabled={busy}>{repo ? S.save : S.add}</button>
        </div>
      </form>
    </div>
  );
}
