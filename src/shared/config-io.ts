/** 配置导入导出（契约 4.3）：主进程和页面共用的类型。 */

/** 导出范围：全部 / 一个产品 / 一个仓库（页面上用本地 id 选；文件里写名字和 slug）。 */
export type ExportScopeArg = { kind: "all" } | { kind: "product"; productId: number } | { kind: "repo"; slug: string };
/** 导出内容：全部 / 只有规矩（含产品）/ 只有检查（E1 注册 checks 之前不可选）。 */
export type ExportContent = "all" | "lessons" | "checks";
export const EXPORT_CONTENTS: readonly ExportContent[] = ["all", "lessons", "checks"];

export interface ExportOptions {
  content: ExportContent;
  /** 带上出处 URL 和 PR 号（默认不带）。 */
  includeSourceUrls: boolean;
}

export interface ExportRequest {
  scope: ExportScopeArg;
  options: ExportOptions;
  /** 起步包：不绑定仓库 / 产品、不带状态和出处的已确认规矩；需要一个名字。 */
  starter?: { name: string };
}

/** 文件里的范围（不含本地 id）。 */
export type FileScope =
  | { kind: "all" }
  | { kind: "product"; name: string }
  | { kind: "repo"; slug: string }
  | { kind: "starter"; name: string };

export type ImportMode = "merge" | "replace";
export type Resolution = "imported" | "local";
export type PreviewStatus = "added" | "changed" | "conflicting" | "unchanged" | "removed";
export const PREVIEW_STATUSES: readonly PreviewStatus[] = ["added", "changed", "conflicting", "unchanged", "removed"];

export interface PreviewDiff {
  field: string;
  local: unknown;
  incoming: unknown;
}

export interface PreviewRow {
  fingerprint: string;
  label: string;
  status: PreviewStatus;
  diffs: PreviewDiff[];
  /** 冲突的原因（决定不同的字段，或语义冲突检测给的理由）。 */
  reasons: string[];
  localId: number | null;
  /** 语义冲突时，和它冲突的那条本地规矩。 */
  relatedId?: number | null;
}

export type PreviewCounts = Record<PreviewStatus, number>;

export interface SectionPreview {
  id: string;
  rows: PreviewRow[];
  counts: PreviewCounts;
}

export interface ImportPreview {
  token: string;
  file: { exportedAt: number; butlerVersion: string; formatVersion: number; scope: FileScope; includeSourceUrls: boolean };
  starter: boolean;
  sections: SectionPreview[];
  /** 文件里有、这个 Butler 不认识的部分：跳过。 */
  skippedSections: string[];
  /** 规矩的语义冲突检测（模型）没查全：没显示出来的冲突可能还有。 */
  semanticFailed?: boolean;
  totals: PreviewCounts;
}

/** 起步包导入到哪：一个仓库或一个产品。 */
export type StarterTarget = { kind: "repo"; slug: string } | { kind: "product"; productId: number };

export interface ImportApplyRequest {
  token: string;
  mode: ImportMode;
  /** 有改动 / 冲突的行默认怎么选：合并模式默认 local，替换模式默认 imported。 */
  bulk?: Resolution;
  /** 逐行的选择（按 部分 id + ":" + fingerprint）。 */
  resolutions?: Record<string, Resolution>;
}

export interface SectionApplyCounts {
  added: number;
  updated: number;
  removed: number;
  kept: number;
  skipped: number;
}

export type ImportApplyResult =
  | { ok: true; batchId: number | null; sections: Record<string, SectionApplyCounts>; backupFile: string | null }
  | { ok: false; reason: "expired" | "backup_failed" | "needs_target" | "bad_target" | "replace_starter" };

export type ImportPreviewResult =
  | { ok: true; preview: ImportPreview }
  | { ok: false; reason: "cancelled" | "not_json" | "not_butler" | "too_new" | "bad_section" | "too_large" | "read_failed" | "expired" | "bad_target"; section?: string };

export type ExportResult = { ok: true; file: string; counts: Record<string, number> } | { ok: false; reason: "cancelled" | "write_failed" | "not_found" | "no_checks" };

export interface ConfigIoStatus {
  lastExportAt: number | null;
  lastBackupAt: number | null;
  backupDir: string;
  backups: { name: string; at: number; size: number }[];
  intervalDays: number;
  keep: number;
  reminderDays: number;
  /** 该提醒导出了：有已确认的规矩，而且 reminderDays 天里没有导出也没有备份。 */
  remind: boolean;
  /** 已注册的部分（checks 出现后「只导出检查」才能选）。 */
  sections: { id: string; content: "lessons" | "checks" | "config" | readonly ("lessons" | "checks" | "config")[] }[];
}
