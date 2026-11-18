// 仓库现状（工作流 E2）的主进程服务：扫描（跳过的记原因）、历史、过期、给 D 的接口（设计 §4.1–4.3）、档案文字、标记文件表的三层。
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Db } from "../db/database";
import { BaselinesRepo } from "../db/baselines-repo";
import type { LessonsRepo } from "../db/lessons-repo";
import type { ChecksService } from "../checks/checks-service";
import { LayeredResolver, type ScopeRef } from "../scope/layered";
import { M } from "../strings";
import { pitfallsFor } from "../lessons/select";
import {
  type BaselineCategory, type BaselineCheck, type BaselineCoverage, type BaselineDraft, type BaselineRepoView, type BaselineSkipReason, type BaselineSummary,
  type BaselinesActResult, type BaselinesAction, type BaselinesView, type InferState, type RepoBaseline, type RuleOrigin, type RuleRowView,
} from "../../shared/baselines";
import type { CheckInput, CheckScope } from "../../shared/checks";
import type { Lang } from "../../shared/i18n";
import type { LessonScope } from "../../shared/lessons";
import { BUILTIN_RULES, parseRuleJson, resolveRules, validateRule, type ResolvedRules, type RuleLayerRow } from "./rules";
import { listRepoFiles, type Listing } from "./listing";
import type { JobRunner, JobHandle } from "./runner";
import type { JobMessage } from "./jobs";
import type { ScanOutput } from "./scan";
import { runInference, type InferRunner } from "./infer";
import { coverageIn } from "./coverage";
import { joinProfiles, profileText } from "./profile-text";
import { readRepoFile } from "./jobs";

export interface BaselinesConfig {
  infer: "auto" | "off";
  autoRescan: boolean;
  guideChars: number;
}

export interface BaselineServiceDeps {
  db: Db;
  lessons: LessonsRepo;
  checks: ChecksService;
  /** slug → 本地仓库路径（登记的仓库）；没有返回 null。 */
  localPath: (slug: string) => string | null;
  runner: JobRunner;
  infer?: InferRunner;
  config: () => BaselinesConfig;
  lang: () => Lang;
  now: () => number;
  /** 列文件（测试里换掉）。 */
  list?: (root: string) => Promise<Listing>;
  /** 有新的扫描结果 / 开始或结束扫描：通知页面。 */
  onChanged?: (slug: string) => void;
  log?: (msg: string, err?: unknown) => void;
}

export type ScanStatus = "ok" | "partial" | "skipped" | "failed" | "unchanged";
export interface ScanResultLine {
  slug: string;
  status: ScanStatus;
  reason?: BaselineSkipReason | string;
}

/** 同时最多跑几个仓库的扫描。 */
export const MAX_PARALLEL_SCANS = 3;

interface ScanEntry {
  handle: JobHandle | null;
  cancelled: boolean;
  opts: ScanOptions;
  promise: Promise<ScanResultLine>;
  /** 这次跑完以后还要再扫一次（要得比这次多的请求合起来）。 */
  next?: ScanOptions;
  after?: Promise<ScanResultLine>;
}

/** 正在跑的 a 是不是已经包含了 b 要的。 */
const covers = (a: ScanOptions, b: ScanOptions): boolean => (a.infer || !b.infer) && (!!a.force || !b.force);

export interface ScanOptions {
  /** 允许调模型补（还要看 baselineInfer 设置）；自动重扫永远是 false。 */
  infer: boolean;
  /** 输入没变也重新存一份。 */
  force?: boolean;
}

/** 过期检查最多看这么多文件、这么久。 */
const STALE_MAX_FILES = 200;
const STALE_BUDGET_MS = 150;
/** 自动重扫：同一个仓库至少隔这么久。 */
export const AUTO_RESCAN_GAP_MS = 10 * 60_000;
const STALE_READ_MAX = 512 * 1024;

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const DRAFT_CATEGORIES: BaselineCategory[] = ["lint", "format", "typecheck"];

/** shell 里安全的单引号写法。 */
const q = (s: string) => (/^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

type RuleDefs = Record<string, RuleLayerRow>;

export class BaselineService {
  readonly repo: BaselinesRepo;
  private readonly running = new Map<string, ScanEntry>();
  /** 同时在跑的扫描数和排队的（「全部扫描」一次可能几百个仓库：每个都起 worker、git ls-files、模型调用）。 */
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly lastAuto = new Map<string, number>();
  private readonly ruleResolver: LayeredResolver<RuleDefs>;

  constructor(private readonly d: BaselineServiceDeps) {
    this.repo = new BaselinesRepo(d.db);
    this.ruleResolver = new LayeredResolver<RuleDefs>({
      defaults: {},
      read: (ref) => {
        const rows = this.repo.rulesInLayer(ref);
        return rows.length ? Object.fromEntries(rows.map((r) => [r.key, r])) : null;
      },
      productsOf: (slug) => d.lessons.productsOf(slug),
      productName: (id) => d.lessons.product(id)?.name ?? null,
    });
  }

  // ---------------------------------------------------------------- 给 D 的接口（设计 §4.1，签名合并前不改）

  /** 最近一次有结果的扫描。 */
  latest(slug: string): RepoBaseline | null {
    return this.repo.latestUsable(slug);
  }

  /** 一个范围里的仓库和它们的扫描结果：全局 = 所有知道的仓库，产品 = 它的仓库。 */
  forScope(scope: CheckScope): { slug: string; baseline: RepoBaseline | null }[] {
    return this.slugsOf(scope).map((slug) => ({ slug, baseline: this.latest(slug) }));
  }

  checksByCategory(slug: string, category: BaselineCategory): BaselineCheck[] {
    return (this.latest(slug)?.checks ?? []).filter((c) => c.category === category);
  }

  /** 这条规矩被哪些现有检查管住了（强的在前）。低置信的也返回（check.confidence 是 low），D 不能只凭它就判定已覆盖。 */
  coveredBy(lesson: { scope: LessonScope; text: string; scopeGlobs?: string[] }): BaselineCoverage[] {
    const slugs = lesson.scope.kind === "repo" ? [lesson.scope.slug] : (this.d.lessons.product(lesson.scope.productId)?.slugs ?? []);
    const out: BaselineCoverage[] = [];
    for (const slug of slugs) {
      const b = this.latest(slug);
      if (b) out.push(...coverageIn(slug, b.checks, lesson.text, lesson.scopeGlobs));
    }
    const conf = (c: BaselineCheck) => (c.confidence === "high" ? 0 : c.confidence === "medium" ? 1 : 2);
    return out.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === "strong" ? -1 : 1) || conf(a.check) - conf(b.check));
  }

  /** 给模型 prompt 用的紧凑文字（check_draft、lesson_classify）。 */
  describeForPrompt(slugs: string[], maxChars = 2000): string {
    const parts: string[] = [];
    for (const slug of slugs) {
      const b = this.latest(slug);
      if (!b || !b.checks.length) continue;
      const lines = [`repo ${slug} (scanned ${new Date(b.scannedAt).toISOString().slice(0, 10)}):`];
      for (const c of b.checks) {
        const facts = c.facts.length ? ` rules: ${c.facts.slice(0, 12).join(", ")}` : "";
        const file = c.fileCommand ? ` per-file: ${c.fileCommand}` : "";
        lines.push(`- ${c.dir || "."} ${c.category} ${c.tool} [${c.confidence}${c.stages.length ? `, runs at ${c.stages.join("/")}` : ""}]: ${c.command}${file}${facts}`);
      }
      parts.push(lines.join("\n"));
    }
    const text = parts.join("\n\n");
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  }

  /** 从仓库现有的 lint / format / 类型检查命令生成 run_command 检查草稿（设计 §4.2）。都是试运行；低置信的要人确认。 */
  suggestedChecks(slug: string): BaselineDraft[] {
    const b = this.latest(slug);
    if (!b) return [];
    const existing = new Set(
      this.d.checks
        .effective({ kind: "repo", slug })
        .filter((c) => c.type === "run_command")
        .map((c) => String(c.params.command ?? "").trim()),
    );
    const out: BaselineDraft[] = [];
    for (const c of b.checks) {
      if (!DRAFT_CATEGORIES.includes(c.category)) continue;
      const input = draftInput(c);
      out.push({ id: c.id, input, confidence: c.confidence, needsConfirm: c.confidence === "low" || b.origin === "imported", exists: existing.has(String(input.params.command)) });
    }
    return out;
  }

  /** 把选中的草稿建成仓库层的检查（一个批次）。低置信的必须在 confirmLow 里。 */
  adopt(slug: string, ids: string[], confirmLow: string[]): BaselinesActResult {
    const drafts = this.suggestedChecks(slug);
    const chosen = drafts.filter((x) => ids.includes(x.id));
    if (!chosen.length) return { ok: false, message: M().baselines.adoptNone };
    const unconfirmed = chosen.filter((x) => x.needsConfirm && !confirmLow.includes(x.id));
    if (unconfirmed.length) return { ok: false, message: M().baselines.adoptConfirm(unconfirmed.map((x) => x.input.name)) };
    const fresh = chosen.filter((x) => !x.exists);
    if (!fresh.length) return { ok: true, created: 0, message: M().baselines.adoptExists };
    const r = this.d.checks.createMany({ kind: "repo", slug }, fresh.map((x) => x.input), { summary: { from: "baseline", slug } });
    return r.ok ? { ok: true, created: r.affected } : { ok: false, message: r.message ?? r.reason };
  }

  /** 一个范围里的仓库一个一个扫（向导用）。不 force 时输入和文件列表都没变的不重存。 */
  async scanScope(scope: CheckScope, o: ScanOptions): Promise<ScanResultLine[]> {
    const out: ScanResultLine[] = [];
    for (const slug of this.slugsOf(scope)) out.push(await this.scan(slug, o));
    return out;
  }

  /** 向导上的数字。 */
  summary(scope: CheckScope): BaselineSummary {
    const s: BaselineSummary = { scanned: 0, skipped: [], byConfidence: { high: 0, medium: 0, low: 0 }, needBasics: [], toConfirm: 0 };
    for (const slug of this.slugsOf(scope)) {
      const last = this.repo.latest(slug);
      if (last && (last.status === "skipped" || last.status === "failed")) s.skipped.push({ slug, reason: last.skipReason ?? "error", detail: last.detail });
      const b = this.latest(slug);
      if (!b) continue;
      s.scanned++;
      for (const c of b.checks) s.byConfidence[c.confidence]++;
      if (b.advice.length) s.needBasics.push(slug);
      s.toConfirm += b.checks.filter((c) => c.confidence === "low").length;
    }
    return s;
  }

  // ---------------------------------------------------------------- 扫描

  isRunning(slug: string): boolean {
    return this.running.has(slug);
  }

  /**
   * 扫一个仓库（最多同时 MAX_PARALLEL_SCANS 个，其余排队）。同一个仓库正在扫时：这次要的那一次已经包含了（比如都不调模型）就返回那一次；
   * 要得更多（要调模型、要强制存）就在它之后再扫一次，免得用户点的「扫描」被正在跑的自动重扫吞掉（审查发现）。
   */
  scan(slug: string, o: ScanOptions): Promise<ScanResultLine> {
    const cur = this.running.get(slug);
    if (cur) {
      if (covers(cur.opts, o)) return cur.promise;
      cur.next = cur.next ? { infer: cur.next.infer || o.infer, force: !!(cur.next.force || o.force) } : { ...o };
      cur.after ??= cur.promise.then(() => this.scan(slug, cur.next!));
      return cur.after;
    }
    const entry: ScanEntry = { handle: null, cancelled: false, opts: o, promise: Promise.resolve<ScanResultLine>({ slug, status: "skipped" }) };
    entry.promise = this.withSlot(() => this.doScan(slug, o, entry))
      .catch((e): ScanResultLine => {
        this.d.log?.(`baseline scan of ${slug} failed`, e);
        this.store(slug, { status: "failed", skipReason: "error", detail: String(e instanceof Error ? e.message : e).slice(0, 500) });
        return { slug, status: "failed", reason: "error" };
      })
      .finally(() => {
        this.running.delete(slug);
        this.d.onChanged?.(slug);
      });
    this.running.set(slug, entry);
    this.d.onChanged?.(slug);
    return entry.promise;
  }

  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_PARALLEL_SCANS) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    try {
      return await run();
    } finally {
      const next = this.waiting.shift();
      // 名额直接交给排队的下一个（active 不变）。
      if (next) next();
      else this.active--;
    }
  }

  cancel(slug: string): boolean {
    const r = this.running.get(slug);
    if (!r) return false;
    r.cancelled = true;
    r.handle?.cancel();
    return true;
  }

  private store(slug: string, p: Partial<RepoBaseline> & Pick<RepoBaseline, "status">): number {
    return this.repo.insert({
      slug, scannedAt: this.d.now(), status: p.status, skipReason: p.skipReason ?? null, detail: p.detail ?? null, origin: "local", projects: p.projects ?? [], checks: p.checks ?? [],
      advice: p.advice ?? [], profile: p.profile ?? { projects: [], dirs: [], ci: [], pitfalls: [] }, inputs: p.inputs ?? [], listingHash: p.listingHash ?? "", staleAt: null,
      inferred: p.inferred ?? "none", inferDetail: p.inferDetail ?? null, durationMs: p.durationMs ?? 0,
    });
  }

  private async doScan(slug: string, o: ScanOptions, entry: { handle: JobHandle | null; cancelled: boolean }): Promise<ScanResultLine> {
    const started = this.d.now();
    const root = this.d.localPath(slug);
    const skip = (reason: BaselineSkipReason, detail: string | null): ScanResultLine => {
      this.store(slug, { status: "skipped", skipReason: reason, detail, durationMs: this.d.now() - started });
      return { slug, status: "skipped", reason };
    };
    // 排队的时候就被取消了。
    if (entry.cancelled) return skip("cancelled", null);
    if (!root) return skip("not_cloned", null);
    const listing = await (this.d.list ?? listRepoFiles)(root);
    if (!listing.ok) return skip(listing.reason, listing.detail || null);
    if (entry.cancelled) return skip("cancelled", null);

    const rules = this.rulesFor(slug);
    let result: ScanOutput | null = null;
    let error: string | null = null;
    const handle = this.d.runner({ kind: "scan", root, files: listing.files, truncated: listing.truncated, rules }, (m: JobMessage) => {
      if (m.type === "scan") result = m.result;
      else if (m.type === "error") error = m.message;
    });
    entry.handle = handle;
    const end = await handle.done;
    entry.handle = null;
    if (entry.cancelled || end.kind === "cancelled") return skip("cancelled", null);
    if (end.kind === "stalled") throw new Error(`scan stalled at ${end.lastFile}`);
    if (end.kind === "crashed") throw new Error(end.message);
    if (error || !result) throw new Error(error ?? "no result");
    let out: ScanOutput = result;

    const prev = this.repo.latestUsable(slug);
    // 输入、文件列表都没变（而且这次不用调模型：要补的上次已经补过，或者这次不让调）：不重存。
    const wantsInference = o.infer && out.inferReasons.length > 0 && prev?.inferred !== "ran" && this.d.config().infer !== "off";
    if (!o.force && prev && prev.origin === "local" && prev.listingHash === out.listingHash && sameInputs(prev.inputs, out.inputs) && !wantsInference) {
      if (prev.staleAt !== null) this.repo.setStale(prev.id, null);
      return { slug, status: "unchanged" };
    }

    let inferred: InferState = "none";
    let inferDetail: string | null = null;
    const cfg = this.d.config();
    if (out.inferReasons.length) {
      if (cfg.infer === "off") inferred = "skipped_off";
      else if (o.infer && this.d.infer) {
        const r = await runInference(this.d.infer, { slug, root, out, files: listing.files });
        if (entry.cancelled) return skip("cancelled", null);
        out = r.out;
        inferred = r.state;
        inferDetail = r.detail;
      } else if (prev && prev.inferred === "ran") {
        // 自动重扫不调模型：上次模型补的那些接着用（确定性结果里有的不覆盖）。
        out = carryInferred(out, prev);
        inferred = "ran";
        inferDetail = prev.inferDetail;
      }
    }
    const status = listing.truncated || inferred === "failed" ? "partial" : "ok";
    const profile = { ...out.profile, pitfalls: this.pitfalls(slug) };
    this.store(slug, {
      status, detail: listing.truncated ? M().baselines.truncated(listing.files.length) : null, projects: out.projects, checks: out.checks, advice: out.advice, profile,
      inputs: out.inputs, listingHash: out.listingHash, inferred, inferDetail, durationMs: this.d.now() - started,
    });
    return { slug, status };
  }

  private pitfalls(slug: string): string[] {
    try {
      return pitfallsFor(this.d.lessons, slug);
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- 过期和档案

  /**
   * 配置文件从上次扫描以后改过没有（按存下的 hash，最多 200 个文件、150 毫秒，剩下的当没变）。改过就记下 stale_at。
   * root 是这次要看的工作副本（ticket 的 worktree），默认是登记的路径。
   */
  checkStale(slug: string, root?: string | null): boolean {
    const b = this.latest(slug);
    if (!b) return false;
    if (b.staleAt !== null) return true;
    const registered = this.d.localPath(slug);
    const dir = root ?? registered;
    if (!dir || b.origin === "imported") return b.origin === "imported";
    const startedAt = Date.now();
    for (const input of b.inputs.slice(0, STALE_MAX_FILES)) {
      if (Date.now() - startedAt > STALE_BUDGET_MS) break;
      const text = readRepoFile(dir, input.path, STALE_READ_MAX);
      if (text === null || sha1(text) !== input.hash) {
        // 只有登记的那份 checkout 改了才记在共用的扫描上；ticket 的 worktree 改了只影响这一次的说明（重扫读的是登记的路径）。
        if (registered && samePath(dir, registered)) this.repo.setStale(b.id, this.d.now());
        return true;
      }
    }
    return false;
  }

  /** 过期了而且开着自动重扫：后台只跑确定性的两层（同一个仓库 10 分钟最多一次）。 */
  maybeRescan(slug: string): boolean {
    if (!this.d.config().autoRescan || this.running.has(slug)) return false;
    const last = this.lastAuto.get(slug) ?? 0;
    if (this.d.now() - last < AUTO_RESCAN_GAP_MS) return false;
    this.lastAuto.set(slug, this.d.now());
    void this.scan(slug, { infer: false });
    return true;
  }

  /** 写进 guide 的文字（profileOnly：guide 里已经有规矩那一段，不重复踩过的坑）。 */
  profileFor(slug: string, o: { stale?: boolean; withPitfalls?: boolean; maxChars?: number } = {}): string {
    const b = this.latest(slug);
    if (!b) return "";
    return profileText(b, { lang: this.d.lang(), maxChars: o.maxChars ?? this.d.config().guideChars, stale: o.stale ?? b.staleAt !== null, pitfalls: o.withPitfalls ?? true });
  }

  /**
   * session guide 里的仓库档案（7.8）：只给这个 ticket 的仓库，每个不超过 baselineGuideChars、合起来不超过两倍。
   * 配置文件改过的标「过期」，开着自动重扫就在后台重扫一次；guide 里已经有规矩那一段时不重复踩过的坑。从不抛错。
   */
  guideProfile(repos: { slug: string; root: string | null }[], hasLessons: boolean): string {
    const texts: string[] = [];
    const seen = new Set<string>();
    for (const r of repos) {
      if (seen.has(r.slug)) continue;
      seen.add(r.slug);
      try {
        const b = this.latest(r.slug);
        // 导入的扫描是别处的结果、没在本机核对过：命令不进 agent 的说明，等本机扫一次。
        if (!b) continue;
        if (b.origin === "imported") {
          this.maybeRescan(r.slug);
          continue;
        }
        const stale = this.checkStale(r.slug, r.root);
        if (stale && this.latest(r.slug)?.staleAt != null) this.maybeRescan(r.slug);
        texts.push(this.profileFor(r.slug, { stale, withPitfalls: !hasLessons }));
      } catch (e) {
        this.d.log?.(`baseline profile for ${r.slug} failed`, e);
      }
    }
    return joinProfiles(texts, 2 * this.d.config().guideChars);
  }

  /** 启动时：上次没跑完的存量扫描标成失败（由存量扫描服务调用也行，这里放一个入口）。 */
  slugsOf(scope: CheckScope): string[] {
    if (scope.kind === "repo") return [scope.slug];
    if (scope.kind === "product") return this.d.lessons.product(scope.productId)?.slugs ?? [];
    const set = new Set(this.d.checks.knownSlugs());
    for (const s of this.repo.slugs()) set.add(s);
    return [...set].sort();
  }

  // ---------------------------------------------------------------- 标记文件表（三层，契约 4.2）

  private layerRows(ref: ScopeRef): { ref: ScopeRef; rows: RuleLayerRow[] }[] {
    return this.ruleResolver.layersFor(ref).map((l) => ({ ref: l.ref, rows: Object.values(l.values).filter((x): x is RuleLayerRow => !!x) as RuleLayerRow[] }));
  }

  rulesFor(slug: string): ResolvedRules {
    return resolveRules(this.layerRows({ kind: "repo", slug }).map((l) => l.rows));
  }

  /** 某一层看到的规则：内置的加上各层的覆盖，带来源。 */
  rulesView(scope: CheckScope): RuleRowView[] {
    const layers = this.layerRows(scope);
    const resolved = resolveRules(layers.map((l) => l.rows));
    const own = new Map((layers.find((l) => sameScopeRef(l.ref, scope))?.rows ?? []).map((r) => [r.key, r]));
    const keys = new Set<string>([...BUILTIN_RULES.map((r) => r.key), ...layers.flatMap((l) => l.rows.map((r) => r.key))]);
    const all = new Map([...resolved.markers, ...resolved.keywords].map((r) => [r.key, r]));
    const out: RuleRowView[] = [];
    for (const key of keys) {
      const o = resolved.origin[key];
      const origin: RuleOrigin = o === undefined || o === "builtin" ? "builtin" : (layers[o]?.ref.kind ?? "global");
      const mine = own.get(key);
      out.push({
        key, rule: all.get(key) ?? null, raw: mine?.rule ?? null, enabled: all.has(key), origin, overridden: !!mine, invalid: resolved.invalid[key] ?? null,
      });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  ruleSave(scope: CheckScope, key: string, raw: string, enabled: boolean): BaselinesActResult {
    const k = key.trim();
    if (!/^[\w.:-]{1,80}$/.test(k)) return { ok: false, message: M().baselines.ruleBadKey };
    if (raw.trim()) {
      const parsed = parseRuleJson(raw);
      if ("error" in parsed) return { ok: false, message: parsed.error };
      // 覆盖内置规则时可以只写要改的字段：和下层合并后再校验。
      const base = this.layerRows(scope).filter((l) => !sameScopeRef(l.ref, scope)).map((l) => l.rows);
      const merged = resolveRules([...base, [{ key: k, rule: raw, enabled: true }]]);
      if (merged.invalid[k]) return { ok: false, message: merged.invalid[k] };
      if (!BUILTIN_RULES.some((r) => r.key === k) && !base.flat().some((r) => r.key === k)) {
        const v = validateRule({ ...parsed.value, key: k });
        if ("error" in v) return { ok: false, message: v.error };
      }
    }
    if (scope.kind === "product" && !this.d.lessons.product(scope.productId)) return { ok: false, message: M().baselines.ruleBadScope };
    this.repo.upsertRule(scope, k, raw.trim() || "{}", enabled, this.d.now());
    return { ok: true };
  }

  ruleRemove(scope: CheckScope, key: string): BaselinesActResult {
    return this.repo.removeRule(scope, key) ? { ok: true } : { ok: false, message: M().baselines.ruleNotFound };
  }

  // ---------------------------------------------------------------- 页面

  view(): BaselinesView {
    const repos: BaselineRepoView[] = this.slugsOf({ kind: "global" }).map((slug) => {
      const last = this.repo.latest(slug);
      return {
        slug, path: this.d.localPath(slug), latest: last, drafts: this.suggestedChecks(slug), profileText: this.profileFor(slug), running: this.running.has(slug),
      };
    });
    return { repos };
  }

  act(a: BaselinesAction): BaselinesActResult {
    switch (a.kind) {
      case "scan":
        for (const slug of a.slugs) void this.scan(slug, { infer: a.infer, force: a.force ?? true });
        return { ok: true };
      case "cancel":
        return this.cancel(a.slug) ? { ok: true } : { ok: false, message: M().baselines.notRunning };
      case "adopt":
        return this.adopt(a.slug, a.ids, a.confirmLow);
      case "ruleSave":
        return this.ruleSave(a.scope, a.key, a.rule, a.enabled);
      case "ruleRemove":
        return this.ruleRemove(a.scope, a.key);
    }
  }
}

/** 两个路径是不是同一个目录（Windows 上不分大小写）。 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function sameScopeRef(a: ScopeRef, b: ScopeRef): boolean {
  return a.kind === b.kind && (a.kind === "global" || (a.kind === "product" ? a.productId === (b as { productId: number }).productId : a.slug === (b as { slug: string }).slug));
}

function sameInputs(a: { path: string; hash: string }[], b: { path: string; hash: string }[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((x) => [x.path, x.hash]));
  return b.every((x) => m.get(x.path) === x.hash);
}

/** 上次模型补的检查和档案字段，在这次的确定性结果上接着用（确定性的优先）。 */
function carryInferred(out: ScanOutput, prev: RepoBaseline): ScanOutput {
  const checks = [...out.checks];
  for (const c of prev.checks) if (c.source === "inferred" && !checks.some((x) => x.dir === c.dir && x.category === c.category)) checks.push(c);
  const projects = out.profile.projects.map((p) => ({ ...p, inferred: [...p.inferred] }));
  for (const pp of prev.profile.projects) {
    if (!pp.inferred.length) continue;
    let t = projects.find((x) => x.dir === pp.dir);
    if (!t) {
      t = { ...pp, install: null, build: null, testAll: null, testOne: null, fastest: null, lint: null, typecheck: null, inferred: [] };
      projects.push(t);
    }
    for (const f of pp.inferred as (keyof typeof pp)[]) {
      const k = f as "install" | "build" | "testAll" | "testOne" | "fastest" | "lint" | "typecheck";
      if (t[k] === null && pp[k]) {
        t[k] = pp[k];
        t.inferred.push(k);
      }
    }
  }
  return { ...out, checks, profile: { ...out.profile, projects } };
}

/** 一条现有检查 → run_command 草稿（设计 §4.2）。子目录项目先 cd 过去，单个文件用 "$OLDPWD/$BUTLER_CHECK_FILE"（路径一直在引号里）。 */
export function draftInput(c: BaselineCheck): CheckInput {
  const perFile = !!c.fileCommand && c.butlerStage === "edit";
  let command: string;
  if (perFile) {
    const fc = c.fileCommand!;
    command = c.dir ? `cd ${q(c.dir)} && ${fc.split("{file}").join('"$OLDPWD/$BUTLER_CHECK_FILE"')}` : fc;
  } else command = c.dir ? `cd ${q(c.dir)} && ${c.command}` : c.command;
  const prefix = c.dir ? `${c.dir}/` : "";
  const exts = c.exts ?? [];
  const globs = exts.length ? [`${prefix}**/*.${exts.length === 1 ? exts[0] : `{${exts.join(",")}}`}`] : c.dir ? [`${c.dir}/**`] : [];
  return {
    type: "run_command", name: M().baselines.draftName(c.tool, c.dir), params: { command, stage: perFile ? "edit" : "push" }, globs, excludeGlobs: [], severity: "block", mode: "shadow",
    enabled: true, message: "",
  };
}
