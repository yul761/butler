import type { LimitHit, LimitKind } from "../../shared/availability";
import {
  EFFORT_LEVELS, LEGACY_TIER_ALIAS, TASK_IDS, isModelName, isTaskId, isTier, routingConfigured, tierRank,
  type DiscoveryView, type EffortLevel, type LimitRule, type RegistryModel, type RouteEventKind, type RoutingAction,
  type RoutingConfig, type RoutingView, type TaskId, type Tier,
} from "../../shared/model-routing";
import type { RoutingRepo } from "../db/routing-repo";
import { M } from "../strings";
import type { SpendRow } from "../db/usage-repo";
import { ModelHealth, type HealthHit } from "./health";
import { correlatedLimit, fingerprint, ruleFromSample } from "./learning";
import { candidatesFor, effectiveChains, planTask, registryTier, tierChain, type Candidate, type Plan } from "./router";
import { BUILTIN_RULES, compileRules, genericSignal, setActiveRules } from "./rules";
import { parseQuotas, parseThresholds, periodEnd, periodStart, summarizeSpend, type SpendSummary } from "./spend";

export interface RoutingSettings {
  quotas: string;
  thresholds: string;
  periodStartDay: number;
  effort: string;
  maxConcurrent: string;
  autoSwitch: boolean;
}

export type ProbeOutcome = { ok: true } | { ok: false; hit: HealthHit | null; message: string };

export interface RoutingServiceDeps {
  repo: RoutingRepo;
  usage: { spendSince: (sinceMs: number) => SpendRow[] };
  settings: () => RoutingSettings;
  /** claude --help 里有没有 --model / --effort。 */
  flags: () => { model: boolean; effort: boolean };
  now: () => number;
  /** 用这个模型发一次最便宜的调用（model_probe）。 */
  probe: (model: string) => Promise<ProbeOutcome>;
  /** 查看 / 跑模型发现（discovery.ts）。 */
  discovery?: { view: () => DiscoveryView | null; run: () => Promise<void> };
  onChange?: () => void;
  log?: (msg: string, err?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface PlanContext {
  sessionModel?: string | null;
  producer?: Candidate | null;
}

/** 交互 session 要的模型（tier / 注册表模型名 / 旧的 opus、sonnet、haiku）→ 实际传给 --model 的。 */
export type SessionModelChoice =
  | { ok: true; model: string | null; requested: string; tier: Tier | null; note: "legacy" | "routed" | "next_healthy" | "no_flag" }
  | { ok: false; error: string };

const SPEND_TTL_MS = 30_000;
const LEGACY_NAMES = new Set(["opus", "sonnet", "haiku", "fable"]);

class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(public max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

function parseJsonMap(v: string): Record<string, unknown> {
  if (!v) return {};
  try {
    const o = JSON.parse(v) as unknown;
    return typeof o === "object" && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** routingEffort：{ "<task id 或 tier>": "low" | … }，不合法的键值丢掉。 */
export function parseEffort(v: string): Partial<Record<string, EffortLevel>> {
  const out: Partial<Record<string, EffortLevel>> = {};
  for (const [k, val] of Object.entries(parseJsonMap(v))) {
    if ((isTaskId(k) || isTier(k)) && (EFFORT_LEVELS as readonly unknown[]).includes(val)) out[k] = val as EffortLevel;
  }
  return out;
}

/** routingMaxConcurrent：{ "high": 1, … }，正整数。 */
export function parseMaxConcurrent(v: string): Partial<Record<Tier, number>> {
  const out: Partial<Record<Tier, number>> = {};
  for (const [k, val] of Object.entries(parseJsonMap(v))) {
    if (isTier(k) && typeof val === "number" && Number.isInteger(val) && val >= 1 && val <= 50) out[k] = val;
  }
  return out;
}

/**
 * 模型路由的总入口（设计 addendum）：配置、健康、花费、识别规则和学习。
 * headless 执行层、交互 session、IPC 和设置页都走这里。
 */
export class RoutingService {
  readonly health: ModelHealth;
  private cfg: RoutingConfig | null = null;
  private spendCache: { at: number; start: number; summary: SpendSummary } | null = null;
  private sems = new Map<Tier, Semaphore>();
  private listeners = new Set<() => void>();
  private probing = new Set<string>();
  private log: (msg: string, err?: unknown) => void;

  constructor(private d: RoutingServiceDeps) {
    this.log = d.log ?? (() => undefined);
    this.health = new ModelHealth({
      repo: d.repo, now: d.now, onChange: () => this.changed(),
      onProbeDue: (m) => void this.runProbe(m, "auto"),
      setTimer: d.setTimer, clearTimer: d.clearTimer, log: d.log,
    });
    this.refreshRules();
    try {
      d.repo.pruneEvents(d.now());
    } catch (e) {
      this.log("routing: pruning events failed", e);
    }
  }

  dispose(): void {
    this.health.dispose();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.spendCache = null;
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        this.log("routing: listener failed", e);
      }
    }
    try {
      this.d.onChange?.();
    } catch (e) {
      this.log("routing: onChange failed", e);
    }
  }

  // ---- 配置 ----

  config(): RoutingConfig {
    this.cfg ??= { registry: this.d.repo.registry(), chains: this.d.repo.chains(), overrides: this.d.repo.taskRoutes() };
    return this.cfg;
  }

  configured(): boolean {
    return routingConfigured(this.config());
  }

  /** 登记过、启用着的模型名。 */
  knows = (model: string): boolean => this.config().registry.some((m) => m.enabled && m.name === model);

  usable = (model: string): boolean => this.health.usable(model);

  private configChanged(): void {
    this.cfg = null;
    this.changed();
  }

  /** 用户 / 学到的规则和内置规则的启用覆盖 → 当前生效的识别规则。 */
  refreshRules(): void {
    try {
      const rows = this.d.repo.rules();
      const disabled = new Set(rows.filter((r) => r.source === "builtin" && !r.enabled).map((r) => r.id));
      const set = compileRules(rows.filter((r) => r.source !== "builtin"), disabled);
      for (const id of set.invalid) this.log(`routing: limit rule ${id} does not compile, skipped`);
      setActiveRules(set);
    } catch (e) {
      this.log("routing: loading limit rules failed, using built-ins", e);
      setActiveRules(compileRules([]));
    }
  }

  // ---- 花费 ----

  spend(): SpendSummary & { periodStart: number; periodEnd: number } {
    const now = this.d.now();
    const s = this.d.settings();
    const start = periodStart(now, s.periodStartDay);
    if (!this.spendCache || this.spendCache.start !== start || now - this.spendCache.at > SPEND_TTL_MS) {
      let rows: SpendRow[] = [];
      try {
        rows = this.d.usage.spendSince(start);
      } catch (e) {
        this.log("routing: reading spend failed", e);
      }
      this.spendCache = { at: now, start, summary: summarizeSpend(rows, this.config().registry, parseQuotas(s.quotas), parseThresholds(s.thresholds)) };
    }
    return { ...this.spendCache.summary, periodStart: start, periodEnd: periodEnd(start) };
  }

  // ---- 规划 ----

  plan(task: TaskId, ctx: PlanContext = {}): Plan {
    const now = this.d.now();
    const configured = this.configured();
    const spend = configured ? this.spend() : null;
    return planTask({
      task, config: this.config(), now,
      usable: (m) => this.health.usable(m, now),
      recoversAt: (m) => this.health.recoversAt(m, now),
      spendLevel: (m, t) => spend?.level(m, t) ?? "ok",
      periodEnd: spend?.periodEnd ?? now,
      sessionModel: ctx.sessionModel ?? null,
      producer: ctx.producer ?? null,
    });
  }

  effortFor(task: TaskId, tier: Tier | null): EffortLevel | null {
    if (!this.d.flags().effort) return null;
    const e = parseEffort(this.d.settings().effort);
    return e[task] ?? (tier ? e[tier] : undefined) ?? null;
  }

  flags(): { model: boolean; effort: boolean } {
    return this.d.flags();
  }

  /** 按档位的并发上限；没设上限立刻放行。 */
  async acquire(tier: Tier | null): Promise<() => void> {
    if (!tier) return () => undefined;
    const max = parseMaxConcurrent(this.d.settings().maxConcurrent)[tier];
    if (!max) return () => undefined;
    let s = this.sems.get(tier);
    if (!s) this.sems.set(tier, (s = new Semaphore(max)));
    s.max = max;
    return s.acquire();
  }

  /** 复盘闸门（配置了路由时用）：lesson_analyze 现在哪里都跑不了就关，到最早恢复的时间。 */
  lessonsBlockedUntil(): number | null {
    if (!this.configured()) return null;
    const p = this.plan("lesson_analyze");
    return p.mode === "wait" ? p.until : null;
  }

  /** 这一档的第一个模型现在能用、也没超阈值：降级的结果可以升级重跑了。 */
  tierHealthy(tier: Tier): boolean {
    if (!this.configured()) return false;
    const first = tierChain(this.config(), tier)[0];
    if (!first) return false;
    return this.health.usable(first) && this.spend().level(first, tier) === "ok";
  }

  // ---- 结果回报 ----

  event(kind: RouteEventKind, e: { task?: string | null; model?: string | null; toModel?: string | null; detail?: string | null } = {}): void {
    try {
      this.d.repo.addEvent({ at: this.d.now(), kind, ...e });
    } catch (err) {
      this.log("routing: recording an event failed", err);
    }
  }

  /** 和这个模型同账号、档位不低于它的启用模型（账号级的限额一起标）。 */
  private accountGroup(model: string, tier: Tier | null): string[] {
    const reg = this.config().registry;
    const self = reg.find((m) => m.name === model);
    const account = self?.account ?? "default";
    const rank = tierRank(self?.tier ?? tier ?? "low");
    const group = reg.filter((m) => m.enabled && m.account === account && tierRank(m.tier) >= rank).map((m) => m.name);
    return [...new Set([model, ...group])];
  }

  /** 撞限：标这个模型，账号级的标同账号里档位不低于它的。返回被标的模型。 */
  onLimit(model: string, hit: LimitHit, o: { task: TaskId | null; accountLevel: boolean; tier?: Tier | null; suspected?: boolean }): string[] {
    const marked = o.accountLevel ? this.accountGroup(model, o.tier ?? null) : [model];
    for (const m of marked) this.health.report(m, { ...hit, suspected: o.suspected });
    this.event(o.suspected ? "suspected" : "limit", { task: o.task, model, detail: `${hit.kind}${marked.length > 1 ? ` (account: ${marked.join(", ")})` : ""}: ${hit.message}` });
    return marked;
  }

  onSuccess(model: string, startedAt: number): void {
    const before = this.health.get(model).state;
    this.health.noteSuccess(model, startedAt);
    if (before !== "ok" && this.health.get(model).state === "ok") this.event("recovered", { model });
  }

  /**
   * 规则没认出来的失败：通用信号（状态码 / 关键词）或者「这个模型连续失败而别的模型成功」→ 记进未识别列表；
   * 配置了路由时当成疑似限额标这个模型（返回这个疑似的撞限，执行层据此降级）。否认过的同类报错不再算。
   */
  onFailure(model: string | null, text: string, apiStatus: number | null, task: TaskId | null): LimitHit | null {
    const now = this.d.now();
    const fp = fingerprint(text) || (apiStatus !== null ? `status ${apiStatus}` : "");
    if (!fp) return null;
    let prev: ReturnType<RoutingRepo["unrecognizedByFingerprint"]> = null;
    try {
      prev = this.d.repo.unrecognizedByFingerprint(fp);
    } catch (e) {
      this.log("routing: reading unrecognised errors failed", e);
    }
    if (prev?.status === "dismissed") {
      if (model) this.health.noteFailure(model, text, now);
      return null;
    }
    const generic = genericSignal({ text, apiStatus });
    let kind: LimitKind | null = generic?.kind ?? null;
    let signal: "generic" | "correlated" | null = generic ? "generic" : null;
    if (model) {
      const streak = this.health.noteFailure(model, text, now);
      if (!signal) {
        const others = this.config().registry.filter((m) => m.enabled && m.name !== model).map((m) => this.health.get(m.name).lastSuccessAt);
        if (correlatedLimit({ consecutiveFailures: streak.count, failureStreakSince: streak.since }, others)) {
          kind = "usage_limit";
          signal = "correlated";
        }
      }
    }
    if (!signal || !kind) return null;
    try {
      this.d.repo.noteUnrecognized({ fingerprint: fp, sample: text.trim().slice(0, 1000), model, signal, now });
    } catch (e) {
      this.log("routing: recording an unrecognised error failed", e);
    }
    if (!this.configured() || !model) {
      this.changed();
      return null;
    }
    const hit: LimitHit = { kind, resetsAt: null, message: text.trim().split("\n").find((l) => l.trim())?.slice(0, 300) ?? kind };
    // 疑似的只标这一个模型（不知道是不是账号级）。
    this.onLimit(model, hit, { task, accountLevel: false, suspected: true });
    return hit;
  }

  // ---- 探测 ----

  private async runProbe(model: string, why: "auto" | "manual"): Promise<void> {
    if (this.probing.has(model)) return;
    this.probing.add(model);
    try {
      const r = await this.d.probe(model);
      if (r.ok) {
        this.health.probeResult(model, { ok: true });
        this.event("probe_ok", { task: "model_probe", model, detail: why });
      } else {
        this.health.probeResult(model, { ok: false, hit: r.hit });
        this.event("probe_failed", { task: "model_probe", model, detail: r.message.slice(0, 300) });
      }
    } catch (e) {
      this.log(`routing: probing ${model} failed`, e);
      this.health.probeResult(model, { ok: false, hit: null });
    } finally {
      this.probing.delete(model);
    }
  }

  // ---- 交互 session ----

  /** start_session 的 model：tier、注册表里的名字、旧的 opus / sonnet / haiku，或省略。 */
  sessionModel(requested: string | null | undefined): SessionModelChoice {
    const flags = this.d.flags();
    if (requested === null || requested === undefined || requested === "") return { ok: true, model: null, requested: "", tier: null, note: "legacy" };
    if (!isTier(requested) && !isModelName(requested)) return { ok: false, error: M().routing.sessionBadModel(requested) };
    if (!flags.model) return { ok: true, model: null, requested, tier: isTier(requested) ? requested : null, note: "no_flag" };
    if (!this.configured()) {
      if (isTier(requested)) return { ok: true, model: LEGACY_TIER_ALIAS[requested], requested, tier: requested, note: "legacy" };
      return { ok: true, model: requested, requested, tier: null, note: "legacy" };
    }
    const config = this.config();
    const tier = isTier(requested) ? requested : registryTier(config, requested);
    if (!tier) {
      // 不在注册表的名字：旧别名照旧传；别的拒绝（配置了路由就只认登记过的）。
      if (LEGACY_NAMES.has(requested)) return { ok: true, model: requested, requested, tier: null, note: "legacy" };
      const names = config.registry.filter((m) => m.enabled).map((m) => m.name);
      return { ok: false, error: M().routing.sessionUnknownModel(requested, names.join(", ")) };
    }
    const chain = candidatesFor(config, tier, "low");
    const ordered = isTier(requested) ? chain : [{ model: requested, tier }, ...chain.filter((c) => c.model !== requested)];
    const healthy = ordered.find((c) => this.health.usable(c.model));
    if (!healthy) return { ok: true, model: ordered[0]?.model ?? null, requested, tier, note: "routed" };
    return { ok: true, model: healthy.model, requested, tier: healthy.tier, note: healthy.model === ordered[0]?.model ? "routed" : "next_healthy" };
  }

  /** session 撞限后「换下一档继续」用的模型：当前档链里它后面能用的，再往下一档。没有为 null。 */
  nextModel(current: string | null): string | null {
    const config = this.config();
    if (!this.configured()) {
      // 没配置：opus → sonnet → haiku。
      const order = ["opus", "sonnet", "haiku"];
      const i = current ? order.indexOf(current) : -1;
      return i >= 0 && i < order.length - 1 ? order[i + 1]! : current === null ? "sonnet" : null;
    }
    const tier: Tier = (current ? registryTier(config, current) : null) ?? "high";
    const chain = candidatesFor(config, tier, "low").map((c) => c.model);
    const start = current ? chain.indexOf(current) + 1 : 0;
    return chain.slice(start).find((m) => m !== current && this.health.usable(m)) ?? null;
  }

  autoSwitch(): boolean {
    return this.d.settings().autoSwitch;
  }

  /** 交互 session 里看到的撞限：配置了路由就标 session 的模型（账号级的按规则）。 */
  onSessionLimit(model: string | null, hit: LimitHit, accountLevel: boolean): void {
    if (!this.configured() || !model) return;
    const name = this.config().registry.find((m) => m.name === model || model.includes(`-${m.name}-`))?.name ?? model;
    this.onLimit(name, hit, { task: null, accountLevel });
  }

  // ---- 设置页 ----

  view(): RoutingView {
    const config = this.config();
    const configured = routingConfigured(config);
    const spend = this.spend();
    const tasks = TASK_IDS.map((task) => {
      const p = this.plan(task);
      const candidates = p.mode === "routed" ? p.candidates.map((c) => c.model) : [];
      const first = p.mode === "legacy" ? (p.model === "session" ? null : p.model) : p.mode === "routed" ? (candidates[0] ?? null) : null;
      return { task, route: p.route, first, candidates };
    });
    const builtinOverrides = new Map(this.d.repo.rules().filter((r) => r.source === "builtin").map((r) => [r.id, r.enabled]));
    const rules: LimitRule[] = [
      ...BUILTIN_RULES.map((r) => ({ ...r, enabled: builtinOverrides.get(r.id) ?? true })),
      ...this.d.repo.rules().filter((r) => r.source !== "builtin"),
    ];
    return {
      configured,
      registry: config.registry,
      chains: config.chains,
      effectiveChains: effectiveChains(config),
      tasks,
      health: this.health.view(),
      events: this.d.repo.events(200),
      unrecognized: this.d.repo.unrecognized(100),
      rules,
      spend: { periodStart: spend.periodStart, byModel: spend.byModel, byTask: spend.byTask, quotas: spend.quotas },
      discovery: this.d.discovery?.view() ?? null,
      flags: this.d.flags(),
    };
  }

  /** 设置页的操作。返回 null 是成功，字符串是给用户看的错误。 */
  async act(a: RoutingAction): Promise<string | null> {
    const { repo } = this.d;
    const now = this.d.now();
    switch (a.op) {
      case "discover":
        if (!this.d.discovery) return M().routing.discoveryUnavailable;
        await this.d.discovery.run();
        this.changed();
        return null;
      case "addModel":
      case "updateModel": {
        const prev = a.op === "updateModel" ? this.config().registry.find((m) => m.name === a.name) : null;
        if (a.op === "updateModel" && !prev) return M().routing.unknownModel(a.name);
        const m: RegistryModel = a.op === "addModel" ? a.model : { ...prev!, ...a.patch, name: a.name };
        const err = validateModel(m);
        if (err) return err;
        if (a.op === "addModel" && this.config().registry.some((x) => x.name === m.name)) return M().routing.alreadyRegistered(m.name);
        repo.upsertModel(m);
        this.configChanged();
        return null;
      }
      case "removeModel":
        repo.removeModel(a.name);
        this.configChanged();
        return null;
      case "moveModel":
        repo.moveModel(a.name, a.delta);
        this.configChanged();
        return null;
      case "setChain":
        if (!isTier(a.tier)) return M().routing.badTier;
        if (!a.models.every(isModelName)) return M().routing.badModelName;
        repo.setChain(a.tier, a.models);
        this.configChanged();
        return null;
      case "setTaskRoute":
        if (!isTaskId(a.route.task)) return M().routing.unknownTask;
        repo.setTaskRoute(a.route);
        this.configChanged();
        return null;
      case "clearTaskRoute":
        repo.clearTaskRoute(a.task);
        this.configChanged();
        return null;
      case "clearHealth":
        this.health.clear(a.model);
        return null;
      case "probe":
        if (!isModelName(a.model)) return M().routing.badModelName;
        await this.runProbe(a.model, "manual");
        return null;
      case "confirmError": {
        const u = repo.unrecognizedById(a.id);
        if (!u) return M().routing.notFound;
        const rule = ruleFromSample(u.sample, a.category, a.accountLevel, `learned:${u.id}`);
        repo.transaction(() => {
          repo.addRule(rule, now);
          repo.setUnrecognizedStatus(u.id, "confirmed", a.category, rule.id);
        });
        this.refreshRules();
        this.changed();
        return null;
      }
      case "dismissError": {
        const u = repo.unrecognizedById(a.id);
        if (!u) return M().routing.notFound;
        repo.setUnrecognizedStatus(u.id, "dismissed", null, null);
        if (u.ruleId) {
          repo.removeRule(u.ruleId);
          this.refreshRules();
        }
        // 这条报错造成的疑似标记清掉。
        for (const m of u.models) if (this.health.get(m).suspected) this.health.clear(m);
        this.changed();
        return null;
      }
      case "addRule": {
        const err = validateRule(a.rule);
        if (err) return err;
        const id = `user:${now.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
        repo.addRule({ ...a.rule, id, source: "user", enabled: true }, now);
        this.refreshRules();
        this.changed();
        return null;
      }
      case "removeRule":
        if (a.id.startsWith("builtin:")) return M().routing.builtinOnlyOff;
        repo.removeRule(a.id);
        this.refreshRules();
        this.changed();
        return null;
      case "toggleRule": {
        const builtin = BUILTIN_RULES.find((r) => r.id === a.id);
        if (builtin) repo.addRule({ ...builtin, enabled: a.enabled }, now);
        else if (!repo.setRuleEnabled(a.id, a.enabled)) return M().routing.notFound;
        this.refreshRules();
        this.changed();
        return null;
      }
      case "rerunDegraded":
        // 由 index.ts 接到复盘的升级重跑上（它订阅了这个服务）。
        this.rerunHook?.();
        return null;
    }
  }

  /** 「立刻升级重跑」按钮的接收方（复盘）。 */
  rerunHook: (() => void) | null = null;
}

export function validateModel(m: RegistryModel): string | null {
  if (!isModelName(m.name)) return M().routing.badModelName;
  if (!isTier(m.tier)) return M().routing.badTier;
  if (typeof m.account !== "string" || m.account.length === 0 || m.account.length > 60) return M().routing.badAccount;
  for (const p of [m.priceIn, m.priceOut]) if (p !== null && (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 10_000)) return M().routing.badPrice;
  if (typeof m.note !== "string" || m.note.length > 200) return M().routing.noteTooLong;
  return null;
}

export function validateRule(r: Omit<LimitRule, "id" | "source" | "enabled">): string | null {
  if (!["regex", "status", "field", "reset"].includes(r.kind)) return M().routing.badRuleKind;
  if (typeof r.pattern !== "string" || r.pattern.trim() === "" || r.pattern.length > 500) return M().routing.badPattern;
  if (r.kind !== "reset" && !r.category) return M().routing.pickCategory;
  const set = compileRules([{ ...r, id: "check", source: "user", enabled: true }]);
  if (set.invalid.length > 0) return r.kind === "status" ? M().routing.badStatusRule : r.kind === "field" ? M().routing.badFieldRule : M().routing.badRegex;
  return null;
}

