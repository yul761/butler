import type { ReleaseInfo } from "../../../shared/update";
import { api } from "../api";
import { reportError } from "../errors";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

/** 顶部的更新提示条（BTL-253）：只是提示，下载在浏览器里开 release 页。 */
export function UpdateBanner() {
  const view = useStateRefetch("update", api.updateState);
  const r = view?.banner;
  return r ? <UpdateBannerView release={r} /> : null;
}

export function UpdateBannerView({ release: r }: { release: ReleaseInfo }) {
  const act = (p: Promise<unknown>) => void p.catch(reportError);
  return (
    <div className="update-banner" role="status" data-testid="update-banner">
      <div className="update-banner-row">
        <strong>{S.update.available(r.version)}</strong>
        <span className="update-banner-actions">
          <button className="primary" data-testid="update-download" onClick={() => act(api.openRelease())}>{S.update.download}</button>
          <button data-testid="update-skip" onClick={() => act(api.skipUpdate(r.version))}>{S.update.skip}</button>
          <button data-testid="update-close" aria-label={S.update.close} title={S.update.close} onClick={() => act(api.dismissUpdate(r.version))}>×</button>
        </span>
      </div>
      <details data-testid="update-notes">
        <summary>{S.update.notes}</summary>
        {/* 说明是 GitHub 上的 Markdown 原文：当纯文本显示，不渲染成 HTML。 */}
        {r.notes.trim() ? <pre className="update-notes">{r.notes}</pre> : <p className="muted">{S.update.noNotes}</p>}
      </details>
    </div>
  );
}
