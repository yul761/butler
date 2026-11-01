import { useState, type FormEvent } from "react";
import type { CreateFeatureInput } from "../../../shared/types";
import { api, ButlerError } from "../api";
import { S } from "../strings";
import { RepoPicker } from "./RepoPicker";

interface FormProps {
  title: string;
  nameLabel: string;
  namePlaceholder: string;
  workspaceHint: string;
  /** 建好后返回 id。 */
  create: (input: CreateFeatureInput) => Promise<number>;
  errorText: (e: unknown) => string;
  onClose: () => void;
  onCreated: (id: number) => void;
}

/** 新建 feature 和新建 epic 共用的对话框：名字、仓库（可以选上一层目录）、工作区目录（留空用默认位置）。 */
export function WorkspaceDialog({ title, nameLabel, namePlaceholder, workspaceHint, create, errorText, onClose, onCreated }: FormProps) {
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
      onCreated(await create({ name, repoPaths: repoPaths.map((p) => p.trim()).filter(Boolean), workspaceDir: workspaceDir.trim() || undefined }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <h2>{title}</h2>
        <label>{nameLabel}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={namePlaceholder} autoFocus required /></label>
        <RepoPicker label={S.repo} onChange={setRepoPaths} required />
        <label>{S.workspaceDir}<input value={workspaceDir} onChange={(e) => setWorkspaceDir(e.target.value)} placeholder={workspaceHint} /></label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>{S.cancel}</button>
          <button type="submit" className="primary" disabled={busy || repoPaths.length === 0}>{S.create}</button>
        </div>
      </form>
    </div>
  );
}

interface Props {
  /** 从 epic 页新建：建好后移进这个 epic（epic 没有的仓库自动加入）。 */
  epicId?: number;
  onClose: () => void;
  onCreated: (id: number) => void;
}

const errorText = (e: unknown) => (e instanceof ButlerError ? (S.createErrors[e.code] ?? e.message) : (e as Error).message);

/** 新建 feature（设计文档 2026-10-26）。 */
export function NewFeatureDialog({ epicId, onClose, onCreated }: Props) {
  async function create(input: CreateFeatureInput) {
    const f = await api.createFeature(input);
    if (epicId !== undefined) await api.moveFeature(f.id, epicId);
    return f.id;
  }

  return (
    <WorkspaceDialog
      title={S.newFeature} nameLabel={S.featureName} namePlaceholder="checkout-redesign" workspaceHint={S.workspaceDefault}
      create={create} errorText={errorText} onClose={onClose} onCreated={onCreated}
    />
  );
}
