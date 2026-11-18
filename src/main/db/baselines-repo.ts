// 仓库现状（工作流 E2）的表：repo_baselines、baseline_rules、legacy_scans / legacy_violations、check_exports。
import type { Db } from "./database";
import type {
  BaselineSkipReason, BaselineStatus, CheckExportView, ExportStatus, ExportTarget, InferState, LegacyScanView, LegacyStatus, LegacyViolation, RepoBaseline,
} from "../../shared/baselines";
import type { CheckScope } from "../../shared/checks";
import { where } from "./checks-repo";
import type { RuleLayerRow } from "../baselines/rules";

const KEEP_PER_SLUG = 10;
export const MAX_VIOLATIONS_STORED = 5000;

const json = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== "string") return fallback;
  try {
    return (JSON.parse(raw) as T) ?? fallback;
  } catch {
    return fallback;
  }
};

interface BaselineRow {
  id: number; repo_slug: string; scanned_at: number; status: string; skip_reason: string | null; detail: string | null; origin: string; projects: string; checks: string;
  advice: string; profile: string; inputs: string; listing_hash: string; stale_at: number | null; inferred: string; infer_detail: string | null; duration_ms: number;
}

function toBaseline(r: BaselineRow): RepoBaseline {
  const profile = json(r.profile, { projects: [], dirs: [], ci: [], pitfalls: [] });
  return {
    id: Number(r.id), slug: r.repo_slug, scannedAt: Number(r.scanned_at), status: r.status as BaselineStatus, skipReason: (r.skip_reason ?? null) as BaselineSkipReason | null,
    detail: r.detail, origin: r.origin === "imported" ? "imported" : "local", projects: json(r.projects, []), checks: json(r.checks, []), advice: json(r.advice, []),
    profile: { projects: profile.projects ?? [], dirs: profile.dirs ?? [], ci: profile.ci ?? [], pitfalls: profile.pitfalls ?? [] },
    inputs: json(r.inputs, []), listingHash: r.listing_hash, staleAt: r.stale_at === null ? null : Number(r.stale_at), inferred: r.inferred as InferState,
    inferDetail: r.infer_detail, durationMs: Number(r.duration_ms),
  };
}

interface ScanRow {
  id: number; check_key: string; repo_slug: string; status: string; started_at: number; finished_at: number | null; files_total: number; files_scanned: number; count: number; error: string | null;
}
const toScan = (r: ScanRow): LegacyScanView => ({
  scanId: Number(r.id), checkKey: r.check_key, slug: r.repo_slug, status: r.status as LegacyStatus, startedAt: Number(r.started_at),
  finishedAt: r.finished_at === null ? null : Number(r.finished_at), filesTotal: Number(r.files_total), filesScanned: Number(r.files_scanned), count: Number(r.count), error: r.error,
});

interface ExportRow {
  id: number; check_key: string; repo_slug: string; target: string; branch: string; base: string; worktree: string; files: string; diff: string; committed: number;
  status: string; detail: string | null; pr_url: string | null; created_at: number;
}
const toExport = (r: ExportRow): CheckExportView => ({
  id: Number(r.id), checkKey: r.check_key, slug: r.repo_slug, target: r.target as ExportTarget, branch: r.branch, base: r.base, worktree: r.worktree,
  files: json(r.files, []), diff: r.diff, status: r.status as ExportStatus, detail: r.detail, prUrl: r.pr_url, committed: r.committed === 1, createdAt: Number(r.created_at),
});

export type NewBaseline = Omit<RepoBaseline, "id">;

export class BaselinesRepo {
  constructor(private readonly db: Db) {}

  // ---------------------------------------------------------------- 扫描结果

  insert(b: NewBaseline): number {
    const r = this.db
      .prepare(
        `INSERT INTO repo_baselines (repo_slug, scanned_at, status, skip_reason, detail, origin, projects, checks, advice, profile, inputs, listing_hash, stale_at, inferred, infer_detail, duration_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        b.slug, b.scannedAt, b.status, b.skipReason, b.detail, b.origin, JSON.stringify(b.projects), JSON.stringify(b.checks), JSON.stringify(b.advice), JSON.stringify(b.profile),
        JSON.stringify(b.inputs), b.listingHash, b.staleAt, b.inferred, b.inferDetail, b.durationMs,
      );
    const id = Number(r.lastInsertRowid);
    this.db
      .prepare(`DELETE FROM repo_baselines WHERE repo_slug = ? AND id NOT IN (SELECT id FROM repo_baselines WHERE repo_slug = ? ORDER BY scanned_at DESC, id DESC LIMIT ${KEEP_PER_SLUG})`)
      .run(b.slug, b.slug);
    return id;
  }

  /** 最近一次扫描（跳过的也算：页面上要显示为什么跳过）。 */
  latest(slug: string): RepoBaseline | null {
    const r = this.db.prepare("SELECT * FROM repo_baselines WHERE repo_slug = ? ORDER BY scanned_at DESC, id DESC LIMIT 1").get(slug) as BaselineRow | undefined;
    return r ? toBaseline(r) : null;
  }

  /** 最近一次有结果的扫描（ok / partial）。 */
  latestUsable(slug: string): RepoBaseline | null {
    const r = this.db
      .prepare("SELECT * FROM repo_baselines WHERE repo_slug = ? AND status IN ('ok','partial') ORDER BY scanned_at DESC, id DESC LIMIT 1")
      .get(slug) as BaselineRow | undefined;
    return r ? toBaseline(r) : null;
  }

  slugs(): string[] {
    return (this.db.prepare("SELECT DISTINCT repo_slug AS s FROM repo_baselines ORDER BY repo_slug").all() as { s: string }[]).map((r) => r.s);
  }

  history(slug: string): RepoBaseline[] {
    return (this.db.prepare("SELECT * FROM repo_baselines WHERE repo_slug = ? ORDER BY scanned_at DESC, id DESC").all(slug) as unknown as BaselineRow[]).map(toBaseline);
  }

  setStale(id: number, at: number | null): void {
    this.db.prepare("UPDATE repo_baselines SET stale_at = ? WHERE id = ?").run(at, id);
  }

  setPitfalls(id: number, pitfalls: string[]): void {
    const b = this.db.prepare("SELECT profile FROM repo_baselines WHERE id = ?").get(id) as { profile: string } | undefined;
    if (!b) return;
    const p = json<Record<string, unknown>>(b.profile, {});
    this.db.prepare("UPDATE repo_baselines SET profile = ? WHERE id = ?").run(JSON.stringify({ ...p, pitfalls }), id);
  }

  // ---------------------------------------------------------------- 标记文件表的层

  rulesInLayer(scope: CheckScope): RuleLayerRow[] {
    const [w, args] = where(scope);
    return (this.db.prepare(`SELECT key, rule, enabled FROM baseline_rules WHERE ${w} ORDER BY id`).all(...args) as { key: string; rule: string; enabled: number }[]).map((r) => ({
      key: r.key, rule: r.rule, enabled: r.enabled === 1,
    }));
  }

  allRules(): (RuleLayerRow & { scope: CheckScope; updatedAt: number })[] {
    return (
      this.db.prepare("SELECT key, rule, enabled, scope_kind, product_id, repo_slug, updated_at FROM baseline_rules ORDER BY id").all() as {
        key: string; rule: string; enabled: number; scope_kind: string; product_id: number | null; repo_slug: string | null; updated_at: number;
      }[]
    ).map((r) => ({
      key: r.key, rule: r.rule, enabled: r.enabled === 1, updatedAt: Number(r.updated_at),
      scope: r.scope_kind === "product" ? { kind: "product", productId: Number(r.product_id) } : r.scope_kind === "repo" ? { kind: "repo", slug: String(r.repo_slug) } : { kind: "global" },
    }));
  }

  upsertRule(scope: CheckScope, key: string, rule: string, enabled: boolean, now: number): void {
    const [w, args] = where(scope);
    const cur = this.db.prepare(`SELECT id FROM baseline_rules WHERE key = ? AND ${w}`).get(key, ...args) as { id: number } | undefined;
    if (cur) this.db.prepare("UPDATE baseline_rules SET rule = ?, enabled = ?, updated_at = ? WHERE id = ?").run(rule, enabled ? 1 : 0, now, cur.id);
    else {
      this.db
        .prepare("INSERT INTO baseline_rules (key, scope_kind, product_id, repo_slug, rule, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(key, scope.kind, scope.kind === "product" ? scope.productId : null, scope.kind === "repo" ? scope.slug : null, rule, enabled ? 1 : 0, now, now);
    }
  }

  removeRule(scope: CheckScope, key: string): boolean {
    const [w, args] = where(scope);
    return Number(this.db.prepare(`DELETE FROM baseline_rules WHERE key = ? AND ${w}`).run(key, ...args).changes) > 0;
  }

  // ---------------------------------------------------------------- 存量扫描

  startScan(checkId: number | null, checkKey: string, slug: string, at: number): number {
    return Number(
      this.db.prepare("INSERT INTO legacy_scans (check_id, check_key, repo_slug, started_at, status) VALUES (?,?,?,?, 'running')").run(checkId, checkKey, slug, at).lastInsertRowid,
    );
  }

  progressScan(id: number, filesTotal: number, filesScanned: number, count: number): void {
    this.db.prepare("UPDATE legacy_scans SET files_total = ?, files_scanned = ?, count = ? WHERE id = ?").run(filesTotal, filesScanned, count, id);
  }

  addViolations(id: number, vs: LegacyViolation[]): void {
    const have = (this.db.prepare("SELECT COUNT(*) AS n FROM legacy_violations WHERE scan_id = ?").get(id) as { n: number }).n;
    const room = Math.max(0, MAX_VIOLATIONS_STORED - Number(have));
    const ins = this.db.prepare("INSERT INTO legacy_violations (scan_id, file, line, snippet) VALUES (?,?,?,?)");
    for (const v of vs.slice(0, room)) ins.run(id, v.file, v.line, v.snippet.slice(0, 300));
  }

  /** 扫描结束：记下结果，同一检查、同一仓库更早的扫描删掉（只留最新的「存量 N」）。 */
  finishScan(id: number, status: LegacyStatus, at: number, p: { filesTotal: number; filesScanned: number; count: number; error: string | null }): void {
    this.db
      .prepare("UPDATE legacy_scans SET status = ?, finished_at = ?, files_total = ?, files_scanned = ?, count = ?, error = ? WHERE id = ?")
      .run(status, at, p.filesTotal, p.filesScanned, p.count, p.error, id);
    const r = this.db.prepare("SELECT check_key, repo_slug FROM legacy_scans WHERE id = ?").get(id) as { check_key: string; repo_slug: string } | undefined;
    if (r) this.db.prepare("DELETE FROM legacy_scans WHERE check_key = ? AND repo_slug = ? AND id < ? AND status != 'running'").run(r.check_key, r.repo_slug, id);
  }

  scan(id: number): LegacyScanView | null {
    const r = this.db.prepare("SELECT * FROM legacy_scans WHERE id = ?").get(id) as ScanRow | undefined;
    return r ? toScan(r) : null;
  }

  latestScan(checkKey: string, slug: string): LegacyScanView | null {
    const r = this.db.prepare("SELECT * FROM legacy_scans WHERE check_key = ? AND repo_slug = ? ORDER BY id DESC LIMIT 1").get(checkKey, slug) as ScanRow | undefined;
    return r ? toScan(r) : null;
  }

  /** 每个 (检查, 仓库) 最新的一次。 */
  latestScans(): LegacyScanView[] {
    return (
      this.db.prepare("SELECT * FROM legacy_scans s WHERE id = (SELECT MAX(id) FROM legacy_scans t WHERE t.check_key = s.check_key AND t.repo_slug = s.repo_slug) ORDER BY id").all() as unknown as ScanRow[]
    ).map(toScan);
  }

  violations(scanId: number, offset: number, limit: number): LegacyViolation[] {
    return (this.db.prepare("SELECT file, line, snippet FROM legacy_violations WHERE scan_id = ? ORDER BY id LIMIT ? OFFSET ?").all(scanId, limit, offset) as {
      file: string; line: number | null; snippet: string;
    }[]).map((r) => ({ file: r.file, line: r.line === null ? null : Number(r.line), snippet: r.snippet }));
  }

  /** 上次 Butler 退出时还在跑的扫描：标成失败。 */
  failRunning(at: number, error: string): number {
    return Number(this.db.prepare("UPDATE legacy_scans SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'").run(at, error).changes);
  }

  // ---------------------------------------------------------------- 导出

  insertExport(e: Omit<CheckExportView, "id" | "prUrl"> & { checkId: number | null }, now: number): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO check_exports (check_id, check_key, repo_slug, target, branch, base, worktree, files, diff, committed, status, detail, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(e.checkId, e.checkKey, e.slug, e.target, e.branch, e.base, e.worktree, JSON.stringify(e.files), e.diff.slice(0, 200_000), e.committed ? 1 : 0, e.status, e.detail, now, now).lastInsertRowid,
    );
  }

  updateExport(id: number, patch: { status?: ExportStatus; detail?: string | null; prUrl?: string | null }, now: number): void {
    const cur = this.getExport(id);
    if (!cur) return;
    this.db
      .prepare("UPDATE check_exports SET status = ?, detail = ?, pr_url = ?, updated_at = ? WHERE id = ?")
      .run(patch.status ?? cur.status, patch.detail === undefined ? cur.detail : patch.detail, patch.prUrl === undefined ? cur.prUrl : patch.prUrl, now, id);
  }

  getExport(id: number): CheckExportView | null {
    const r = this.db.prepare("SELECT * FROM check_exports WHERE id = ?").get(id) as ExportRow | undefined;
    return r ? toExport(r) : null;
  }

  exports(limit = 100): CheckExportView[] {
    return (this.db.prepare("SELECT * FROM check_exports ORDER BY id DESC LIMIT ?").all(limit) as unknown as ExportRow[]).map(toExport);
  }
}
