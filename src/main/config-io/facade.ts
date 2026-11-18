import { mkdirSync } from "node:fs";
import type {
  ConfigIoStatus, ExportRequest, ExportResult, ImportApplyRequest, ImportApplyResult, ImportPreviewResult, StarterTarget,
} from "../../shared/config-io";
import type { ConfigBackups } from "./backup-job";
import { fileStamp } from "./format";
import type { ConfigIoService } from "./service";

/** 文件选择框（主进程里开；e2e 换成固定的路径）。返回 null 表示取消。 */
export interface ConfigDialogs {
  save(defaultName: string): Promise<string | null>;
  open(): Promise<string | null>;
}

/** 页面用到的导入导出操作（IPC 层只做参数校验，调到这里）。 */
export interface ConfigIoFacade {
  status(): ConfigIoStatus;
  exportTo(req: ExportRequest): Promise<ExportResult>;
  importPreview(): Promise<ImportPreviewResult>;
  retarget(token: string, target: StarterTarget): Promise<ImportPreviewResult>;
  apply(req: ImportApplyRequest): ImportApplyResult;
  backupNow(): { ok: true; name: string } | { ok: false };
  openBackups(): Promise<void>;
}

export interface ConfigIoFacadeDeps {
  io: ConfigIoService;
  backups: ConfigBackups;
  dialogs: ConfigDialogs;
  backupDir: string;
  openPath: (dir: string) => Promise<unknown>;
  notify: () => void;
  now: () => number;
  log?: (msg: string, e?: unknown) => void;
}

/** 起步包的文件名里只留字母数字和连字符。 */
const safeName = (s: string) => s.normalize("NFKC").replace(/[^\p{L}\p{N}-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "starter";

export function configIoFacade(d: ConfigIoFacadeDeps): ConfigIoFacade {
  return {
    status: () => d.backups.status(),
    async exportTo(req) {
      const stamp = fileStamp(d.now());
      const file = await d.dialogs.save(req.starter ? `butler-starter-${safeName(req.starter.name)}-${stamp}.json` : `butler-export-${stamp}.json`);
      if (!file) return { ok: false, reason: "cancelled" };
      const r = d.io.writeExport(req, file);
      if (r.ok) d.notify();
      return r;
    },
    async importPreview() {
      const file = await d.dialogs.open();
      if (!file) return { ok: false, reason: "cancelled" };
      return d.io.previewFile(file);
    },
    retarget: (token, target) => d.io.retarget(token, target),
    apply(req) {
      const r = d.io.apply(req);
      if (r.ok) d.notify();
      return r;
    },
    backupNow() {
      try {
        const file = d.backups.backupNow();
        d.notify();
        return { ok: true, name: file.split(/[\\/]/).pop() ?? file };
      } catch (e) {
        d.log?.("config backup now failed", e);
        return { ok: false };
      }
    },
    async openBackups() {
      mkdirSync(d.backupDir, { recursive: true });
      await d.openPath(d.backupDir);
    },
  };
}
