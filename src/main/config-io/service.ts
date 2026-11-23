import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/database";
import type { LessonsRepo } from "../db/lessons-repo";
import type { BatchRecorder } from "../batches/batch-recorder";
import type { AdmissionPolicyService } from "../lessons/admission-policies";
import type {
  ExportRequest, ExportScopeArg, FileScope, ImportApplyRequest, ImportApplyResult, ImportPreview, ImportPreviewResult, PreviewRow,
  Resolution, SectionApplyCounts, SectionPreview, StarterTarget,
} from "../../shared/config-io";
import { CONFIG_FORMAT, CURRENT_FORMAT_VERSION, ConfigFormatError, fileStamp, parseDoc, serializeDoc, type ConfigDoc } from "./format";
import { countRows, type DiffContext, type ExportSelection, type SectionEnv, type SectionRegistry, type StarterBinding } from "./registry";
import type { LessonConflictDetector, LessonItem } from "./sections";
import { lessonRowsKey } from "./sections";
import type { LessonOwner } from "./fingerprint";

export interface ConfigIoDeps {
  db: Db;
  repo: LessonsRepo;
  policies: AdmissionPolicyService;
  recorder: BatchRecorder;
  registry: SectionRegistry;
  shipherdVersion: string;
  /** 备份目录：<SHIPHERD_HOME>/backups。 */
  backupDir: string;
  now: () => number;
  /** 导出 / 备份之后记一下时间（「定期导出」提醒用）。 */
  onExported?: (at: number) => void;
  /** 导入应用完（有改动）：检查快照之类的派生文件跟着重写。 */
  onApplied?: () => void;
  log?: (msg: string, e?: unknown) => void;
}

/** 预览留着等应用：同时最多几个、多久过期。 */
const MAX_PENDING = 5;
/** 预览留多久：逐行挑选可能要很久，给足时间；最多留 MAX_PENDING 份，内存有上限。 */
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;

interface Pending {
  doc: ConfigDoc;
  bound: StarterBinding | null;
  /** 语义冲突检测给的结果（按 fingerprint）。 */
  semantic: Map<string, { localId: number; reason: string }>;
  /** 语义冲突检测有一部分（或全部）失败了。 */
  semanticFailed: boolean;
  skipped: string[];
  at: number;
}

export type BackupKind = "auto" | "before-replace" | "manual";

/** 导入导出（契约 4.3）：一个带 formatVersion 的 JSON 文件；各部分注册进 SectionRegistry。 */
export class ConfigIoService {
  private readonly pending = new Map<string, Pending>();
  private detector: LessonConflictDetector | null = null;

  constructor(private readonly d: ConfigIoDeps) {}

  /** D 的语义冲突检测挂在这里（没挂就只按字段比）。 */
  setLessonConflictDetector(fn: LessonConflictDetector | null): void {
    this.detector = fn;
  }

  private env(): SectionEnv {
    return { db: this.d.db, repo: this.d.repo, policies: this.d.policies, now: this.d.now() };
  }

  private selection(scope: ExportScopeArg): ExportSelection | null {
    if (scope.kind === "all") return { kind: "all" };
    if (scope.kind === "repo") return this.d.repo.repo(scope.slug) ? { kind: "repo", slug: scope.slug } : null;
    const p = this.d.repo.product(scope.productId);
    return p ? { kind: "product", productId: p.id, name: p.name, slugs: p.slugs } : null;
  }

  /** 组一个导出文件；范围里的产品 / 仓库不存在返回 null。 */
  exportDoc(req: ExportRequest): ConfigDoc | null {
    const sel = this.selection(req.scope);
    if (!sel) return null;
    const starter = req.starter !== undefined;
    const env = this.env();
    const sections: Record<string, unknown[]> = {};
    for (const s of this.d.registry.forContent(req.options.content, starter)) {
      if (s.include && !s.include(req.options)) continue;
      sections[s.id] = s.export(sel, { ...env, options: starter ? { ...req.options, includeSourceUrls: false } : req.options, starter });
    }
    const scope: FileScope = starter
      ? { kind: "starter", name: req.starter!.name.trim() || "starter" }
      : sel.kind === "all" ? { kind: "all" } : sel.kind === "repo" ? { kind: "repo", slug: sel.slug } : { kind: "product", name: sel.name };
    return {
      format: CONFIG_FORMAT, formatVersion: CURRENT_FORMAT_VERSION, exportedAt: env.now, shipherdVersion: this.d.shipherdVersion, scope,
      options: starter ? { content: "lessons", includeSourceUrls: false } : req.options, sections,
    };
  }

  /** 写到 file（先写临时文件再改名，写一半不会留下坏文件）。 */
  writeExport(req: ExportRequest, file: string): { ok: true; file: string; counts: Record<string, number> } | { ok: false; reason: "not_found" | "write_failed" | "no_checks" } {
    if (!req.starter && req.options.content === "checks" && !this.d.registry.list().some((s) => s.id === "checks")) return { ok: false, reason: "no_checks" };
    const doc = this.exportDoc(req);
    if (!doc) return { ok: false, reason: "not_found" };
    try {
      atomicWrite(file, serializeDoc(doc));
    } catch (e) {
      this.d.log?.("config export: write failed", e);
      return { ok: false, reason: "write_failed" };
    }
    this.d.onExported?.(doc.exportedAt);
    return { ok: true, file, counts: Object.fromEntries(Object.entries(doc.sections).map(([k, v]) => [k, v.length])) };
  }

  /** 把全部配置写一份备份到备份目录；返回文件路径。写失败抛错。 */
  backup(kind: BackupKind): string {
    const doc = this.exportDoc({ scope: { kind: "all" }, options: { content: "all", includeSourceUrls: true } })!;
    mkdirSync(this.d.backupDir, { recursive: true });
    let file = join(this.d.backupDir, `${kind}-${fileStamp(doc.exportedAt)}.json`);
    for (let i = 2; exists(file); i++) file = join(this.d.backupDir, `${kind}-${fileStamp(doc.exportedAt)}-${i}.json`);
    atomicWrite(file, serializeDoc(doc));
    return file;
  }

  /** 备份目录里的文件，新的在前。 */
  backups(): { name: string; at: number; size: number }[] {
    let names: string[];
    try {
      names = readdirSync(this.d.backupDir);
    } catch {
      return [];
    }
    return names
      .filter((n) => /^(auto|before-replace|manual)-.+\.json$/.test(n))
      .flatMap((name) => {
        try {
          const st = statSync(join(this.d.backupDir, name));
          return [{ name, at: st.mtimeMs, size: st.size }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  }

  /** 自动备份只留最新的 keep 个（替换前的备份和手动备份不动）。 */
  pruneAutoBackups(keep: number): number {
    const autos = this.backups().filter((b) => b.name.startsWith("auto-"));
    let removed = 0;
    for (const b of autos.slice(Math.max(0, keep))) {
      try {
        rmSync(join(this.d.backupDir, b.name));
        removed++;
      } catch (e) {
        this.d.log?.("config backup: prune failed", e);
      }
    }
    return removed;
  }

  // ------------------------------------------------------------ 导入

  /** 读文件并预览。 */
  async previewFile(file: string): Promise<ImportPreviewResult> {
    let text: string;
    try {
      const st = statSync(file);
      if (st.size > 50 * 1024 * 1024) return { ok: false, reason: "too_large" };
      text = readFileSync(file, "utf8");
    } catch {
      return { ok: false, reason: "read_failed" };
    }
    return this.previewText(text);
  }

  async previewText(text: string, target?: StarterTarget): Promise<ImportPreviewResult> {
    let doc: ConfigDoc;
    try {
      doc = parseDoc(text);
    } catch (e) {
      if (e instanceof ConfigFormatError) return { ok: false, reason: e.reason, section: e.section };
      throw e;
    }
    const skipped: string[] = [];
    const sections: Record<string, unknown[]> = {};
    for (const [id, items] of Object.entries(doc.sections)) {
      const s = this.d.registry.get(id);
      if (!s) {
        skipped.push(id);
        continue;
      }
      const parsed: unknown[] = [];
      for (const raw of items) {
        const p = s.item.safeParse(raw);
        if (!p.success) return { ok: false, reason: "bad_section", section: id };
        parsed.push(p.data);
      }
      sections[id] = parsed;
    }
    doc = { ...doc, sections };
    this.gc();
    const token = randomUUID();
    const pending: Pending = { doc, bound: null, semantic: new Map(), semanticFailed: false, skipped, at: this.d.now() };
    this.pending.set(token, pending);
    if (target) {
      const b = this.bindTarget(target);
      if (!b) return { ok: false, reason: "bad_target" };
      pending.bound = b;
    }
    return { ok: true, preview: await this.buildPreview(token, pending) };
  }

  /** 起步包：选好导入到哪之后重新预览（指纹要绑定之后才算得出来）。 */
  async retarget(token: string, target: StarterTarget): Promise<ImportPreviewResult> {
    const p = this.live(token);
    if (!p) return { ok: false, reason: "expired" };
    const b = this.bindTarget(target);
    if (!b) return { ok: false, reason: "bad_target" };
    p.bound = b;
    return { ok: true, preview: await this.buildPreview(token, p) };
  }

  private bindTarget(t: StarterTarget): StarterBinding | null {
    if (t.kind === "repo") return this.d.repo.repo(t.slug) ? { repo: t.slug } : null;
    const p = this.d.repo.product(t.productId);
    return p ? { product: p.name } : null;
  }

  /** 取一个预览；每次用到（换目标、应用）都重新计时。 */
  private live(token: string): Pending | null {
    this.gc();
    const p = this.pending.get(token) ?? null;
    if (p) p.at = this.d.now();
    return p;
  }

  private gc(): void {
    const now = this.d.now();
    for (const [k, v] of this.pending) if (now - v.at > PENDING_TTL_MS) this.pending.delete(k);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
  }

  private diffAll(p: Pending): { id: string; rows: PreviewRow[] }[] {
    const env = this.env();
    const starter = p.doc.scope.kind === "starter";
    return this.d.registry
      .list()
      .filter((s) => s.id in p.doc.sections)
      .map((s) => {
        if (starter && !p.bound) return { id: s.id, rows: [] };
        const ctx: DiffContext<unknown> = { ...env, items: p.doc.sections[s.id]!, fileScope: p.doc.scope, doc: p.doc.sections, bound: p.bound };
        const rows = s.diff(ctx).map((r) => this.withSemantic(s.id, r, p));
        return { id: s.id, rows };
      });
  }

  private withSemantic(section: string, r: PreviewRow, p: Pending): PreviewRow {
    if (section !== "lessons" || r.status !== "added") return r;
    const hit = p.semantic.get(r.fingerprint);
    return hit ? { ...r, status: "conflicting", reasons: [...r.reasons, hit.reason], relatedId: hit.localId } : r;
  }

  private async buildPreview(token: string, p: Pending): Promise<ImportPreview> {
    p.semantic = new Map();
    p.semanticFailed = false;
    if (this.detector && (p.doc.scope.kind !== "starter" || p.bound)) {
      const first = this.diffAll(p).find((s) => s.id === "lessons");
      const items = (p.doc.sections.lessons ?? []) as LessonItem[];
      const ctx = { ...this.env(), items, fileScope: p.doc.scope, doc: p.doc.sections, bound: p.bound } as DiffContext<LessonItem>;
      const byFp = new Map(items.map((it) => [lessonRowsKey(it, ctx), it]));
      const incoming = (first?.rows ?? [])
        .filter((r) => r.status === "added")
        .flatMap((r) => {
          const it = byFp.get(r.fingerprint);
          const owner: LessonOwner | null = p.bound ?? it?.owner ?? null;
          return it && owner ? [{ fingerprint: r.fingerprint, text: it.text, owner }] : [];
        });
      if (incoming.length) {
        const names = new Map(this.d.repo.products().map((x) => [x.id, x.name]));
        const local = this.d.repo.lessons({ status: ["pending", "confirmed", "disabled"] }).flatMap((l) => {
          const owner: LessonOwner | null = l.scope.kind === "repo" ? { repo: l.scope.slug } : names.has(l.scope.productId) ? { product: names.get(l.scope.productId)! } : null;
          return owner ? [{ id: l.id, text: l.text, owner }] : [];
        });
        try {
          for (const c of await this.detector(incoming, local, () => (p.semanticFailed = true))) if (!p.semantic.has(c.fingerprint)) p.semantic.set(c.fingerprint, { localId: c.localId, reason: c.reason });
        } catch (e) {
          p.semanticFailed = true;
          this.d.log?.("config import: conflict detector failed", e);
        }
      }
    }
    const sections: SectionPreview[] = this.diffAll(p).map(({ id, rows }) => ({ id, rows, counts: countRows(rows) }));
    const totals = countRows(sections.flatMap((s) => s.rows));
    return {
      token,
      file: { exportedAt: p.doc.exportedAt, shipherdVersion: p.doc.shipherdVersion, formatVersion: p.doc.formatVersion, scope: p.doc.scope, includeSourceUrls: p.doc.options.includeSourceUrls },
      starter: p.doc.scope.kind === "starter",
      sections,
      skippedSections: p.skipped,
      ...(p.semanticFailed ? { semanticFailed: true } : {}),
      totals,
    };
  }

  /**
   * 应用预览：整个导入是一个批次（kind import / replace，origin import），可以一键撤销。
   * 合并：新加的进来，改动 / 冲突默认留本地的，文件里没有的本地条目不动。
   * 替换：先写一份备份（失败就不动），改动 / 冲突默认用导入的，文件范围里本地有、文件没有的删掉。
   */
  apply(req: ImportApplyRequest): ImportApplyResult {
    const p = this.live(req.token);
    if (!p) return { ok: false, reason: "expired" };
    const starter = p.doc.scope.kind === "starter";
    if (starter && !p.bound) return { ok: false, reason: "needs_target" };
    if (starter && req.mode === "replace") return { ok: false, reason: "replace_starter" };
    let backupFile: string | null = null;
    if (req.mode === "replace") {
      try {
        backupFile = this.backup("before-replace");
      } catch (e) {
        this.d.log?.("config import: backup before replace failed", e);
        return { ok: false, reason: "backup_failed" };
      }
    }
    const now = this.d.now();
    const counts: Record<string, SectionApplyCounts> = {};
    const { outcome } = this.d.recorder.run(
      { kind: req.mode === "replace" ? "replace" : "import", origin: "import", entity: "lesson", scope: { file: p.doc.scope, mode: req.mode }, now },
      (batch) => {
        const diffs = this.diffAll(p);
        const merge = (id: string, c: SectionApplyCounts) => {
          const t = (counts[id] ??= { added: 0, updated: 0, removed: 0, kept: 0, skipped: 0 });
          for (const k of Object.keys(c) as (keyof SectionApplyCounts)[]) t[k] += c[k];
        };
        for (const phase of ["upsert", "remove"] as const) {
          for (const { id, rows } of phase === "upsert" ? diffs : [...diffs].reverse()) {
            const s = this.d.registry.get(id)!;
            const decide = (row: PreviewRow): Resolution => {
              const own = req.resolutions?.[`${id}:${row.fingerprint}`];
              if (own) return own;
              if (row.status === "added" || row.status === "removed") return "imported";
              return req.bulk ?? (req.mode === "replace" ? "imported" : "local");
            };
            merge(id, s.apply({
              ...this.env(), now, items: p.doc.sections[id]!, fileScope: p.doc.scope, doc: p.doc.sections, bound: p.bound,
              rows, mode: req.mode, phase, batch, decide,
            }));
          }
        }
      },
    );
    if (outcome.batchId !== null) this.d.recorder.setSummary(outcome.batchId, { sections: counts, skippedSections: p.skipped, backupFile: backupFile ? basename(backupFile) : null });
    this.pending.delete(req.token);
    if (outcome.batchId !== null) this.d.onApplied?.();
    return { ok: true, batchId: outcome.batchId, sections: counts, backupFile };
  }
}

function basename(f: string): string {
  return f.split(/[\\/]/).pop() ?? f;
}

function exists(f: string): boolean {
  try {
    statSync(f);
    return true;
  } catch {
    return false;
  }
}

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
