import { randomBytes } from "node:crypto";
import type { Db } from "../db/database";
import type { LessonsRepo } from "../db/lessons-repo";
import type { BatchContext, BatchRecorder } from "../batches/batch-recorder";
import { ChecksRepo, emptyStats } from "../db/checks-repo";
import { LayeredResolver, type Origin, type ScopeRef } from "../scope/layered";
import { M } from "../strings";
import {
  CHECKS_SNAPSHOT_VERSION, sameScope, validateCheckInput,
  type CheckAbsenceReason, type CheckEffectiveView, type CheckHitView, type CheckInput, type CheckRow, type CheckScope, type CheckSnapshot, type CheckVerdict,
  type ChecksAction, type ChecksActResult, type ChecksBulkOp, type ChecksView, type ResolvedCheck,
} from "../../shared/checks";
import type { LessonCheckability } from "../../shared/lessons";
import type { BatchOrigin } from "../../shared/batches";

export interface ChecksConfig {
  enabled: boolean;
  editTimeoutSec: number;
  pushTimeoutSec: number;
  ticketPattern: string;
}

export interface ChecksServiceDeps {
  db: Db;
  lessons: LessonsRepo;
  recorder: BatchRecorder;
  config: () => ChecksConfig;
  now: () => number;
  /** 检查或它们的层变了：重写快照（防抖由写快照的一方做）。 */
  onChanged?: () => void;
  /** 最近一次写快照的情况（页面上显示）。 */
  snapshotStatus?: () => { writtenAt: number | null; error: string | null };
}

/** 解析器里一条检查的样子：参数存成 JSON 字符串，窄层的同 key 行整条盖掉宽层的（addendum 第 3 节）。 */
interface CheckDef {
  id: number;
  type: string;
  name: string;
  params: string;
  globs: string[];
  excludeGlobs: string[];
  severity: string;
  mode: string;
  enabled: boolean;
  message: string;
  lessonId: number | null;
}
type Defs = Record<string, CheckDef>;

const NOT_FOUND = { ok: false as const, reason: "not_found" };
const newKey = () => `ck_${randomBytes(6).toString("hex")}`;

/** checks 表的规范层（契约 4.2：全局 → 产品 → 仓库）和对它的所有改动（契约 4.4：每次一个可撤销的批次）。 */
/** 检查的模式改了（工作流 F 的校准监听）。 */
export interface CheckModeChange {
  ids: number[];
  mode: "shadow" | "enforce";
  origin: BatchOrigin;
  batchId: number;
  at: number;
}

export class ChecksService {
  readonly repo: ChecksRepo;
  readonly resolver: LayeredResolver<Defs>;

  constructor(private readonly d: ChecksServiceDeps) {
    this.repo = new ChecksRepo(d.db);
    this.resolver = new LayeredResolver<Defs>({
      defaults: {},
      read: (ref) => {
        const rows = this.repo.inLayer(ref);
        if (!rows.length) return null;
        return Object.fromEntries(rows.map((r) => [r.key, toDef(r)]));
      },
      productsOf: (slug) => d.lessons.productsOf(slug),
      productName: (id) => d.lessons.product(id)?.name ?? null,
    });
  }

  // ---------------------------------------------------------------- 解析

  /** 某一层看到的每个 key：生效的那一行和它来自哪一层（含停用的）。 */
  private resolved(scope: CheckScope): { key: string; row: CheckRow; origin: ScopeRef }[] {
    const r = this.resolver.resolve(scope);
    const out: { key: string; row: CheckRow; origin: ScopeRef }[] = [];
    for (const [key, def] of Object.entries(r.value)) {
      const o: Origin | undefined = r.origin[`${key}.id`];
      const row = this.repo.get(def.id);
      if (!row || !o || o === "default") continue;
      out.push({ key, row, origin: o });
    }
    return out.sort((a, b) => a.row.id - b.row.id);
  }

  /** 某一层生效、启用的检查，已经本地化（快照里就是这个）。 */
  effective(scope: CheckScope): ResolvedCheck[] {
    return this.resolved(scope).filter((x) => x.row.enabled).map((x) => this.localize(x.row));
  }

  /** 某个仓库看到的这条检查（三层合并后，含停用的），存量扫描和导出用（工作流 E2）。 */
  resolvedFor(slug: string, key: string): (ResolvedCheck & { enabled: boolean; origin: ScopeRef }) | null {
    const x = this.resolved({ kind: "repo", slug }).find((r) => r.key === key);
    return x ? { ...this.localize(x.row), enabled: x.row.enabled, origin: x.origin } : null;
  }

  private localize(r: CheckRow): ResolvedCheck {
    const s = M().checks;
    return {
      id: r.id, key: r.key, type: r.type, name: r.name || s.typeName[r.type], params: r.params, globs: r.globs, excludeGlobs: r.excludeGlobs,
      severity: r.severity, mode: r.mode, message: r.message || s.defaultMessage[r.type],
    };
  }

  /** 快照里要单独列出的仓库：登记过的、属于某个产品的、有仓库层检查的。别的仓库用 global。 */
  knownSlugs(): string[] {
    const set = new Set<string>();
    for (const r of this.d.lessons.repos()) set.add(r.slug);
    for (const p of this.d.lessons.products()) for (const s of p.slugs) set.add(s);
    for (const r of this.repo.all()) if (r.scope.kind === "repo") set.add(r.scope.slug);
    return [...set].sort();
  }

  /** hook 读的快照（addendum 第 3 节）：按仓库预先合并好，hook 自己不合并层。 */
  snapshot(): CheckSnapshot {
    const cfg = this.d.config();
    const global = this.effective({ kind: "global" });
    const repos: Record<string, ResolvedCheck[]> = {};
    for (const slug of this.knownSlugs()) repos[slug] = this.effective({ kind: "repo", slug });
    return {
      v: CHECKS_SNAPSHOT_VERSION, generatedAt: this.d.now(), enabled: cfg.enabled, editTimeoutMs: cfg.editTimeoutSec * 1000, pushTimeoutMs: cfg.pushTimeoutSec * 1000,
      ticketPattern: cfg.ticketPattern, strings: { ...M().checks.snapshot }, global, repos,
    };
  }

  /** 至少有一条启用的检查（任何一层）。没有的话「没有检查」不用提示。 */
  anyEnabled(): boolean {
    return this.repo.enabledCount() > 0;
  }

  // ---------------------------------------------------------------- 页面

  private label(s: ScopeRef): string {
    return s.kind === "global" ? "global" : s.kind === "repo" ? s.slug : (this.d.lessons.product(s.productId)?.name ?? `#${s.productId}`);
  }

  view(scope: CheckScope): ChecksView {
    const stats = this.repo.stats();
    const own = new Map(this.repo.inLayer(scope).map((r) => [r.key, r]));
    const seen = new Set<string>();
    const lessonText = (id: number | null) => (id === null ? null : (this.d.lessons.get(id)?.text ?? null));
    const checks: CheckEffectiveView[] = this.resolved(scope).map(({ key, row, origin }) => {
      seen.add(key);
      return { key, check: row, origin, originLabel: this.label(origin), own: own.get(key) ?? null, stats: stats.get(key) ?? emptyStats(), lessonText: lessonText(row.lessonId) };
    });
    // 这一层自己的行一定能看到（解析时不会漏，这里兜底）。
    for (const [key, row] of own) {
      if (seen.has(key)) continue;
      checks.push({ key, check: row, origin: scope, originLabel: this.label(scope), own: row, stats: stats.get(key) ?? emptyStats(), lessonText: lessonText(row.lessonId) });
    }
    const cfg = this.d.config();
    return {
      scope, checks,
      products: this.d.lessons.products().map((p) => ({ id: p.id, name: p.name })),
      repos: this.knownSlugs(),
      settings: { enabled: cfg.enabled, editTimeoutSec: cfg.editTimeoutSec, pushTimeoutSec: cfg.pushTimeoutSec },
      snapshot: this.d.snapshotStatus?.() ?? { writtenAt: null, error: null },
    };
  }

  hits(checkKey: string, limit = 200): CheckHitView[] {
    return this.repo.hits({ checkKey, limit });
  }

  setVerdict(hitId: number, verdict: CheckVerdict | null): ChecksActResult {
    return this.repo.setVerdict(hitId, verdict, this.d.now()) ? { ok: true, batchId: null, affected: 1 } : NOT_FOUND;
  }

  // ---------------------------------------------------------------- 给 G（提交前审查）的接口

  /** 这些 session 启动时有没有检查（null = 有，或根本没有启用的检查）。 */
  sessionCoverage(ids: string[]): Record<string, { absent: CheckAbsenceReason | null }> {
    if (!ids.length) return {};
    const rows = this.d.db
      .prepare(`SELECT id, checks_absent FROM sessions WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as { id: string; checks_absent: string | null }[];
    const out: Record<string, { absent: CheckAbsenceReason | null }> = {};
    for (const id of ids) out[id] = { absent: null };
    for (const r of rows) out[r.id] = { absent: (r.checks_absent ?? null) as CheckAbsenceReason | null };
    return out;
  }

  hitsForSessions(ids: string[], limit = 1000): CheckHitView[] {
    return this.repo.hits({ sessionIds: ids, limit });
  }

  // ---------------------------------------------------------------- 改动（每次一个批次）

  private layerExists(scope: CheckScope): boolean {
    return scope.kind !== "product" || this.d.lessons.product(scope.productId) !== null;
  }

  private changed<T extends ChecksActResult>(r: T): T {
    if (r.ok && (r.batchId !== null || r.affected > 0)) this.d.onChanged?.();
    return r;
  }

  /**
   * 新建（id 为 null）或编辑这一层的一条检查。lessonId：从这条规矩生成的，规矩的 checkability 同一个批次里改成 converted。
   */
  save(scope: CheckScope, id: number | null, raw: unknown, opts: { lessonId?: number | null; origin?: BatchOrigin } = {}): ChecksActResult {
    const v = validateCheckInput(raw);
    if (!v.ok) return { ok: false, reason: "invalid", message: v.error };
    if (!this.layerExists(scope)) return NOT_FOUND;
    const existing = id === null ? null : this.repo.get(id);
    if (id !== null && (!existing || !sameScope(existing.scope, scope))) return NOT_FOUND;
    if (opts.lessonId && !this.d.lessons.get(opts.lessonId)) return NOT_FOUND;
    const now = this.d.now();
    const { outcome, result } = this.d.recorder.run(
      { kind: id === null ? "check_create" : "check_edit", origin: opts.origin ?? "manual", entity: "check", scope: { layer: scope }, summary: { name: v.value.name, type: v.value.type }, now },
      (ctx) => this.saveIn(ctx, scope, id, v.value, { lessonId: opts.lessonId ?? null }),
    );
    if (typeof result !== "number") return result;
    if (existing && outcome.batchId !== null && existing.mode !== v.value.mode)
      this.emitMode({ ids: [existing.id], mode: v.value.mode, origin: opts.origin ?? "manual", batchId: outcome.batchId, at: now });
    return this.changed({ ok: true, batchId: outcome.batchId, affected: outcome.affected, id: result });
  }

  /**
   * 在调用方已经开着的批次里新建或编辑一条检查（规矩准入的「全部接受」把草稿和确认放进同一个批次，工作流 D）。
   * 返回新行的 id；参数不对或层不存在时什么也不写，返回失败。调用方在批次结束后自己调 notifyChanged()。
   */
  saveIn(ctx: BatchContext, scope: CheckScope, id: number | null, raw: unknown, opts: { lessonId?: number | null } = {}): number | Extract<ChecksActResult, { ok: false }> {
    const v = validateCheckInput(raw);
    if (!v.ok) return { ok: false, reason: "invalid", message: v.error };
    if (!this.layerExists(scope)) return NOT_FOUND;
    const existing = id === null ? null : this.repo.get(id);
    if (id !== null && (!existing || !sameScope(existing.scope, scope))) return NOT_FOUND;
    const lesson = opts.lessonId ? this.d.lessons.get(opts.lessonId) : null;
    if (opts.lessonId && !lesson) return NOT_FOUND;
    const now = this.d.now();
    let rowId: number;
    if (existing) {
      ctx.track("check", existing.id);
      this.repo.update(existing.id, v.value, now);
      rowId = existing.id;
    } else {
      rowId = this.repo.insert(scope, newKey(), v.value, { lessonId: lesson?.id ?? null, now });
      ctx.created("check", rowId);
    }
    if (lesson && lesson.checkability !== "converted") {
      ctx.track("lesson", lesson.id);
      this.d.lessons.setFields(lesson.id, { checkability: "converted" }, now);
    }
    return rowId;
  }

  /** 批次外写了检查之后通知重写快照。 */
  notifyChanged(): void {
    this.d.onChanged?.();
  }

  /** 一次新建好几条（仓库现状里采纳的检查，工作流 E2）：一个批次，撤销时一起撤。有一条不合法就一条都不建。 */
  createMany(scope: CheckScope, raws: unknown[], opts: { origin?: BatchOrigin; summary?: Record<string, unknown> } = {}): ChecksActResult {
    const inputs: CheckInput[] = [];
    for (const raw of raws) {
      const v = validateCheckInput(raw);
      if (!v.ok) return { ok: false, reason: "invalid", message: v.error };
      inputs.push(v.value);
    }
    if (!inputs.length) return { ok: true, batchId: null, affected: 0 };
    if (!this.layerExists(scope)) return NOT_FOUND;
    const now = this.d.now();
    const { outcome } = this.d.recorder.run(
      { kind: "check_create", origin: opts.origin ?? "manual", entity: "check", scope: { layer: scope }, summary: { count: inputs.length, names: inputs.map((i) => i.name).slice(0, 20), ...opts.summary }, now },
      (ctx) => {
        for (const input of inputs) ctx.created("check", this.repo.insert(scope, newKey(), input, { lessonId: null, now }));
      },
    );
    return this.changed({ ok: true, batchId: outcome.batchId, affected: outcome.affected });
  }

  /** 把继承来的一条检查复制到这一层（同一个 key = 覆盖），之后在这一层改它。 */
  override(scope: CheckScope, key: string, patch: Partial<Pick<CheckInput, "enabled" | "mode" | "severity">> = {}): ChecksActResult {
    if (scope.kind === "global") return { ok: false, reason: "bad_scope" };
    if (!this.layerExists(scope)) return NOT_FOUND;
    if (this.repo.byKey(scope, key)) return { ok: false, reason: "exists" };
    const inherited = this.resolved(scope).find((x) => x.key === key);
    if (!inherited) return NOT_FOUND;
    const src = inherited.row;
    const input: CheckInput = {
      type: src.type, name: src.name, params: src.params, globs: src.globs, excludeGlobs: src.excludeGlobs, severity: patch.severity ?? src.severity,
      mode: patch.mode ?? src.mode, enabled: patch.enabled ?? src.enabled, message: src.message,
    };
    const now = this.d.now();
    const { outcome, result } = this.d.recorder.run(
      { kind: "check_override", origin: "manual", entity: "check", scope: { layer: scope, key }, summary: { name: src.name, type: src.type }, now },
      (ctx) => {
        const id = this.repo.insert(scope, key, input, { lessonId: src.lessonId, now });
        ctx.created("check", id);
        return id;
      },
    );
    return this.changed({ ok: true, batchId: outcome.batchId, affected: outcome.affected, id: result });
  }

  /** 选中的几条一起改（启用、停用、试运行、强制、拦截、警告、删除），一个批次。 */
  bulk(ids: number[], op: ChecksBulkOp, opts: { origin?: BatchOrigin; kind?: string; summary?: Record<string, unknown> } = {}): ChecksActResult {
    const unique = [...new Set(ids)].slice(0, 1000);
    const now = this.d.now();
    const before = new Map(unique.map((id) => [id, this.repo.get(id)?.mode ?? null]));
    const { outcome } = this.d.recorder.run(
      { kind: opts.kind ?? `check_${op}`, origin: opts.origin ?? "manual", entity: "check", scope: { ids: unique.length }, summary: opts.summary, now },
      (ctx) => {
        for (const id of unique) {
          const r = this.repo.get(id);
          if (!r) continue;
          if (op === "delete") {
            ctx.track("check", id);
            this.repo.remove(id);
            continue;
          }
          const patch =
            op === "enable" || op === "disable" ? { enabled: op === "enable" } : op === "shadow" || op === "enforce" ? { mode: op } : { severity: op as "block" | "warn" };
          const same =
            ("enabled" in patch && patch.enabled === r.enabled) || ("mode" in patch && patch.mode === r.mode) || ("severity" in patch && patch.severity === r.severity);
          if (same) {
            ctx.skip();
            continue;
          }
          ctx.track("check", id);
          this.repo.setFields(id, patch, now);
        }
      },
    );
    if (outcome.batchId !== null && (op === "shadow" || op === "enforce"))
      this.emitMode({ ids: unique.filter((id) => before.get(id) !== null && before.get(id) !== op), mode: op, origin: opts.origin ?? "manual", batchId: outcome.batchId, at: now });
    return this.changed({ ok: true, batchId: outcome.batchId, affected: outcome.affected });
  }

  private readonly modeListeners: ((e: CheckModeChange) => void)[] = [];
  /** 检查的模式被改了（批量或编辑；工作流 F：人把刚自动升级 / 降级的检查改回去，记校准样本）。 */
  onModeChanged(fn: (e: CheckModeChange) => void): void {
    this.modeListeners.push(fn);
  }

  private emitMode(e: CheckModeChange): void {
    if (!e.ids.length) return;
    for (const fn of this.modeListeners) {
      try {
        fn(e);
      } catch {
        // 监听方的错不影响这次改动。
      }
    }
  }

  /** 手动给规矩分类：能写成检查 / 只能是文字 / 清掉。一个批次。 */
  classifyLesson(lessonId: number, checkability: LessonCheckability | null, opts: { origin?: BatchOrigin; reason?: string } = {}): ChecksActResult {
    const l = this.d.lessons.get(lessonId);
    if (!l) return NOT_FOUND;
    if (l.checkability === checkability) return { ok: true, batchId: null, affected: 0 };
    const now = this.d.now();
    const { outcome } = this.d.recorder.run(
      { kind: "lesson_checkability", origin: opts.origin ?? "manual", entity: "lesson", scope: { ids: 1 }, summary: { checkability, ...(opts.reason ? { reason: opts.reason.slice(0, 500) } : {}) }, now },
      (ctx) => {
        ctx.track("lesson", lessonId);
        this.d.lessons.setFields(lessonId, { checkability }, now);
      },
    );
    if ((opts.origin ?? "manual") === "manual" && outcome.batchId !== null) this.classified?.(lessonId, l.checkability, checkability, l.checkabilityReason);
    return { ok: true, batchId: outcome.batchId, affected: outcome.affected };
  }

  private classified: ((lessonId: number, before: LessonCheckability | null, after: LessonCheckability | null, beforeReason: string | null) => void) | null = null;
  /** 人改了一条规矩的分类以后（工作流 D：重判这一条，推翻了流水线的分类时记一个校准样本）。 */
  onLessonClassified(fn: (lessonId: number, before: LessonCheckability | null, after: LessonCheckability | null, beforeReason: string | null) => void): void {
    this.classified = fn;
  }

  /** 检查页上的一个操作（checks:act），参数已经过 IPC 校验。 */
  act(a: ChecksAction): ChecksActResult {
    switch (a.op) {
      case "save":
        return this.save(a.scope, a.id, a.input, { lessonId: a.lessonId ?? null });
      case "override":
        return this.override(a.scope, a.key);
      case "bulk":
        return this.bulk(a.ids, a.verb);
      case "verdict":
        return this.setVerdict(a.hitId, a.verdict);
      case "classify":
        return this.classifyLesson(a.lessonId, a.checkability);
    }
  }

  /** 删掉超过保留期的命中记录。 */
  prune(retentionMs: number): number {
    return this.repo.pruneHits(this.d.now() - retentionMs);
  }
}

function toDef(r: CheckRow): CheckDef {
  return {
    id: r.id, type: r.type, name: r.name, params: JSON.stringify(r.params), globs: r.globs, excludeGlobs: r.excludeGlobs, severity: r.severity, mode: r.mode,
    enabled: r.enabled, message: r.message, lessonId: r.lessonId,
  };
}
