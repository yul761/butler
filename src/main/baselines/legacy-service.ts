// 存量扫描（设计 §7）：一条检查在整个仓库里现在有多少处违规。在 worker 里跑，可以取消，有看门狗；结果给页面和 F（回测）。
import type { ChecksService } from "../checks/checks-service";
import type { BaselinesRepo } from "../db/baselines-repo";
import { M } from "../strings";
import { listRepoFiles, type Listing } from "./listing";
import type { JobHandle, JobRunner } from "./runner";
import type { JobMessage, LegacyResult } from "./jobs";
import type { LegacyLatest, LegacyScanResult, LegacyScanView, LegacyViolation } from "../../shared/baselines";

export interface LegacyServiceDeps {
  repo: BaselinesRepo;
  checks: ChecksService;
  localPath: (slug: string) => string | null;
  runner: JobRunner;
  config: () => { maxFiles: number; ticketPattern: string; editTimeoutSec: number; pushTimeoutSec: number };
  now: () => number;
  list?: (root: string) => Promise<Listing>;
  env?: () => Record<string, string | undefined>;
  onChanged?: () => void;
  log?: (msg: string, err?: unknown) => void;
}

/** 进度写库最多这么频繁。 */
const PROGRESS_WRITE_MS = 500;

export class LegacyScanService {
  private readonly running = new Map<number, { handle: JobHandle | null; cancelled: boolean; key: string; slug: string }>();

  constructor(private readonly d: LegacyServiceDeps) {}

  /** 启动时：上次退出时没跑完的标成失败。 */
  recover(): number {
    return this.d.repo.failRunning(this.d.now(), M().legacy.interrupted);
  }

  // ---------------------------------------------------------------- 给 F 的接口（设计 §7）

  latest(checkKey: string, slug: string): LegacyLatest | null {
    const s = this.d.repo.latestScan(checkKey, slug);
    if (!s || s.status === "running") return null;
    return { scanId: s.scanId, count: s.count, at: s.finishedAt ?? s.startedAt, status: s.status };
  }

  violations(scanId: number, offset: number, limit: number): LegacyViolation[] {
    return this.d.repo.violations(scanId, Math.max(0, offset), Math.min(Math.max(1, limit), 5000));
  }

  /** 扫一次，等它跑完。 */
  async run(checkId: number, slug: string): Promise<LegacyScanResult> {
    const row = this.d.checks.repo.get(checkId);
    const check = row ? this.d.checks.resolvedFor(slug, row.key) : null;
    if (!row || !check) return { ok: false, message: M().legacy.noCheck };
    if ([...this.running.values()].some((r) => r.key === check.key && r.slug === slug)) return { ok: false, message: M().legacy.running };
    const root = this.d.localPath(slug);
    if (!root) return { ok: false, message: M().legacy.notCloned };
    const scanId = this.d.repo.startScan(check.id, check.key, slug, this.d.now());
    const entry = { handle: null as JobHandle | null, cancelled: false, key: check.key, slug };
    this.running.set(scanId, entry);
    this.d.onChanged?.();
    try {
      await this.execute(scanId, root, check, entry);
    } catch (e) {
      this.d.log?.(`legacy scan ${scanId} failed`, e);
      this.d.repo.finishScan(scanId, "failed", this.d.now(), { ...this.counts(scanId), error: String(e instanceof Error ? e.message : e).slice(0, 500) });
    } finally {
      this.running.delete(scanId);
      this.d.onChanged?.();
    }
    return { ok: true, scan: this.d.repo.scan(scanId)! };
  }

  /** 页面按钮：在后台扫，马上返回这次扫描的 id。 */
  start(checkId: number, slug: string): { ok: true } | { ok: false; message: string } {
    const row = this.d.checks.repo.get(checkId);
    const check = row ? this.d.checks.resolvedFor(slug, row.key) : null;
    if (!row || !check) return { ok: false, message: M().legacy.noCheck };
    if ([...this.running.values()].some((r) => r.key === check.key && r.slug === slug)) return { ok: false, message: M().legacy.running };
    if (!this.d.localPath(slug)) return { ok: false, message: M().legacy.notCloned };
    void this.run(checkId, slug);
    return { ok: true };
  }

  cancel(scanId: number): boolean {
    const r = this.running.get(scanId);
    if (!r) return false;
    r.cancelled = true;
    r.handle?.cancel();
    return true;
  }

  isRunning(scanId: number): boolean {
    return this.running.has(scanId);
  }

  views(): LegacyScanView[] {
    return this.d.repo.latestScans();
  }

  private counts(scanId: number): { filesTotal: number; filesScanned: number; count: number } {
    const s = this.d.repo.scan(scanId);
    return { filesTotal: s?.filesTotal ?? 0, filesScanned: s?.filesScanned ?? 0, count: s?.count ?? 0 };
  }

  private async execute(
    scanId: number,
    root: string,
    check: { type: string; params: Record<string, unknown>; globs: string[]; excludeGlobs: string[] },
    entry: { handle: JobHandle | null; cancelled: boolean },
  ): Promise<void> {
    const listing = await (this.d.list ?? listRepoFiles)(root);
    if (!listing.ok) throw new Error(listing.detail || listing.reason);
    if (entry.cancelled) {
      this.d.repo.finishScan(scanId, "cancelled", this.d.now(), { filesTotal: 0, filesScanned: 0, count: 0, error: null });
      return;
    }
    const cfg = this.d.config();
    const push = check.type === "run_command" && check.params.stage === "push";
    let result: LegacyResult | null = null;
    let error: string | null = null;
    let progress = { filesTotal: 0, filesScanned: 0, count: 0 };
    let lastWrite = 0;
    const handle = this.d.runner(
      {
        kind: "legacy", root, files: listing.files, check: { type: check.type, params: check.params, globs: check.globs, excludeGlobs: check.excludeGlobs }, ticketPattern: cfg.ticketPattern,
        maxFiles: cfg.maxFiles, timeoutMs: (push ? cfg.pushTimeoutSec : cfg.editTimeoutSec) * 1000, env: this.d.env?.() ?? { ...process.env },
      },
      (m: JobMessage) => {
        if (m.type === "violations") this.d.repo.addViolations(scanId, m.items);
        else if (m.type === "progress") {
          progress = { filesTotal: m.filesTotal, filesScanned: m.filesScanned, count: m.count };
          const t = Date.now();
          if (t - lastWrite >= PROGRESS_WRITE_MS) {
            lastWrite = t;
            this.d.repo.progressScan(scanId, m.filesTotal, m.filesScanned, m.count);
            this.d.onChanged?.();
          }
        } else if (m.type === "legacy") result = m.result;
        else if (m.type === "error") error = m.message;
      },
    );
    entry.handle = handle;
    const end = await handle.done;
    entry.handle = null;
    const now = this.d.now();
    // 进程内运行时取消也会正常发出最后的结果：以取消为准。
    if (entry.cancelled || end.kind === "cancelled") {
      const r = result as LegacyResult | null;
      this.d.repo.finishScan(scanId, "cancelled", now, r ? { filesTotal: r.filesTotal, filesScanned: r.filesScanned, count: r.count, error: null } : { ...progress, error: null });
      return;
    }
    if (end.kind === "stalled") {
      this.d.repo.finishScan(scanId, "failed", now, { ...progress, error: M().legacy.stalled(end.lastFile) });
      return;
    }
    if (end.kind === "crashed") throw new Error(end.message);
    if (error) throw new Error(error === "timeout" ? M().legacy.timeout : error);
    const r = result as LegacyResult | null;
    if (!r) throw new Error("no result");
    this.d.repo.finishScan(scanId, r.status, now, { filesTotal: r.filesTotal, filesScanned: r.filesScanned, count: r.count, error: null });
  }
}
