import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { renderBranch } from "../../../shared/branch";
import { DEFAULT_TICKET_PATTERN } from "../../../shared/ticket-pattern";
import type { Feature, WorkMode } from "../../../shared/types";
import { api, ShipherdError } from "../api";
import { lastSegment } from "../repos";
import { S } from "../strings";
import { isValidTicketKey, suggestNextKey } from "../ticket-key-suggest";
import { RepoPicker } from "./RepoPicker";

interface Props {
  onClose: () => void;
  onCreated: (key: string) => void;
  /** 输入的 ticket 号已经归档时，可以直接恢复它。 */
  onRestored: (key: string) => void;
  /** 建在这个 feature 下：仓库从 feature 的仓库里勾选，worktree 放进 feature 的工作区（设计文档 2026-10-26）。 */
  feature?: Feature;
  /** 下一个号按这些 ticket 算（BTL-264）：在 epic 下建是这个 epic 的 ticket，否则是所有 ticket。 */
  contextTickets?: { key: string; createdAt: number }[];
  /** 别处已经用掉的号（不在 contextTickets 里的），建议时跳过；已归档的对话框自己去取。 */
  takenKeys?: string[];
}

export function NewTicketDialog({ onClose, onCreated, onRestored, feature, contextTickets = [], takenKeys = [] }: Props) {
  const [key, setKey] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);
  /** 用户自己动过 ticket 号：之后不再自动填建议的号。 */
  const keyTouched = useRef(false);
  const [pattern, setPattern] = useState<string | null>(null);
  const [archivedKeys, setArchivedKeys] = useState<string[] | null>(null);
  /** ticket 号格式不对时的提示（失焦或提交时检查）。 */
  const [keyError, setKeyError] = useState<string | null>(null);
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
    api.settings().then(
      (s) => (setTemplate(s.branchTemplate), setPattern(s.ticketPattern || DEFAULT_TICKET_PATTERN)),
      // 设置读不到：不知道用户配的格式，界面上不拦（空串），交给主进程判；建议照默认格式算。
      () => (setTemplate(null), setPattern("")),
    );
    api.archivedTickets().then((ts) => setArchivedKeys(ts.map((t) => t.key)), () => setArchivedKeys([]));
  }, []);
  // 设置和已归档的号都到了才算建议，免得先建议一个已归档的号再改掉。
  const suggestion = useMemo(
    () => (pattern === null || archivedKeys === null ? null : suggestNextKey(contextTickets, [...takenKeys, ...archivedKeys], pattern || DEFAULT_TICKET_PATTERN)),
    // 列表刷新了（别处刚建了这个号）建议跟着往后挪；用户动过输入框就不再覆盖（见下）。
    [pattern, archivedKeys, contextTickets, takenKeys],
  );
  useEffect(() => {
    if (!suggestion || keyTouched.current) return;
    setKey(suggestion);
  }, [suggestion]);
  // 光标还在号的输入框里：选中填好的号，直接打字就换掉。在填进去的同一次提交里同步选中：建议晚到（列表刷新后改了号）
  // 正赶上用户开始输入时，React 改 value 会把光标挪到末尾，接着输入的字就接在建议后面（DMS-2DMS-2）。
  useLayoutEffect(() => {
    const el = keyInput.current;
    if (el && !keyTouched.current && key && key === suggestion && document.activeElement === el) el.select();
  }, [key, suggestion]);
  const customPattern = pattern && pattern !== DEFAULT_TICKET_PATTERN ? pattern : null;
  // 自定义格式又给不出建议：不知道合格的号长什么样，不举例（PROJ-123 不一定符合）。
  const example = suggestion ?? (customPattern ? null : "PROJ-123");
  /** 号的格式不对时的提示；格式对或者还没填返回 null。 */
  const formatError = (k: string) =>
    k.trim() && pattern && !isValidTicketKey(k.trim().toUpperCase(), pattern) ? S.ticketKeyFormatError(k.trim(), example, customPattern) : null;
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
    const bad = formatError(key);
    setKeyError(bad);
    if (bad) {
      keyInput.current?.focus();
      return;
    }
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
      setError(err instanceof ShipherdError ? (S.createErrors[err.code] ?? err.message) : (err as Error).message);
      if (err instanceof ShipherdError && err.code === "archived") setArchivedKey(key.trim().toUpperCase());
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
        <label>
          {S.ticketKey}
          <input
            ref={keyInput}
            value={key}
            onChange={(e) => {
              keyTouched.current = true;
              setKey(e.target.value);
              setArchivedKey(null);
              // 已经报过格式错：改对了就马上消掉。
              if (keyError) setKeyError(formatError(e.target.value));
            }}
            onBlur={() => setKeyError(formatError(key))}
            placeholder={example ?? undefined}
            aria-invalid={keyError ? true : undefined}
            aria-describedby="new-ticket-key-hint"
            data-testid="new-ticket-key"
            autoFocus
            required
          />
        </label>
        {keyError ? (
          <p className="error" id="new-ticket-key-hint" data-testid="new-ticket-key-error">{keyError}</p>
        ) : (
          <p className="muted field-hint" id="new-ticket-key-hint" data-testid="new-ticket-key-hint">
            {S.ticketKeyHint(example, suggestion && key === suggestion ? (feature ? "feature" : "all") : null, customPattern)}
          </p>
        )}
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
