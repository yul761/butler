import { useState, type FormEvent } from "react";
import { api, ButlerError } from "../api";
import { S } from "../strings";
import { RepoPicker } from "./RepoPicker";

interface Props {
  onClose: () => void;
  onCreated: (id: number) => void;
}

/** 新建 feature（设计文档 2026-10-26）：名字、仓库（可以选上一层目录）、工作区目录（留空用默认位置）。 */
export function NewFeatureDialog({ onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [repoPaths, setRepoPaths] = useState<string[]>([]);
  const [workspaceDir, setWorkspaceDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const f = await api.createFeature({ name, repoPaths: repoPaths.map((p) => p.trim()).filter(Boolean), workspaceDir: workspaceDir.trim() || undefined });
      onCreated(f.id);
    } catch (err) {
      setError(err instanceof ButlerError ? (S.createErrors[err.code] ?? err.message) : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>{S.newFeature}</h2>
        <label>{S.featureName}<input value={name} onChange={(e) => setName(e.target.value)} placeholder="checkout-redesign" autoFocus required /></label>
        <RepoPicker label={S.repo} onChange={setRepoPaths} required />
        <label>{S.workspaceDir}<input value={workspaceDir} onChange={(e) => setWorkspaceDir(e.target.value)} placeholder={S.workspaceDefault} /></label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>{S.cancel}</button>
          <button type="submit" className="primary" disabled={busy || repoPaths.length === 0}>{S.create}</button>
        </div>
      </form>
    </div>
  );
}
