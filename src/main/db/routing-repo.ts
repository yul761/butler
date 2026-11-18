import type { LimitKind } from "../../shared/availability";
import {
  isTaskId, isTier,
  type HealthState, type LimitPolicy, type LimitRule, type RegistryModel, type RouteEvent, type RouteEventKind,
  type TaskId, type TaskRouteOverride, type Tier, type UnrecognizedError, type UnrecognizedStatus,
} from "../../shared/model-routing";
import { withTransaction, type Db } from "./database";

/** 一个模型的健康状态（model_health 一行）。 */
export interface StoredHealth {
  model: string;
  state: HealthState;
  kind: LimitKind | null;
  until: number | null;
  resetKnown: boolean;
  backoffStep: number;
  /** 最近一次撞限的时间（比它早开始的运行成功了也说明不了现在）。 */
  hitAt: number | null;
  suspected: boolean;
  consecutiveFailures: number;
  failureStreakSince: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureText: string | null;
}

export const EVENTS_KEEP_MS = 30 * 86_400_000;
const SAMPLE_MAX = 1000;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

interface HealthRow {
  model: string; state: HealthState; kind: string | null; until: number | null; reset_known: number; backoff_step: number; hit_at: number | null;
  suspected: number; consecutive_failures: number; failure_streak_since: number | null; last_success_at: number | null; last_failure_at: number | null;
  last_failure_text: string | null;
}
interface RuleRow { id: string; kind: LimitRule["kind"]; pattern: string; category: string | null; account_level: number; source: LimitRule["source"]; enabled: number; note: string }
interface UnrecRow { id: number; fingerprint: string; sample: string; count: number; models: string; first_seen: number; last_seen: number; status: UnrecognizedStatus; category: string | null; signal: string; rule_id: string | null }

const toRule = (r: RuleRow): LimitRule => ({
  id: r.id, kind: r.kind, pattern: r.pattern, category: (r.category as LimitKind | null) ?? null, accountLevel: r.account_level === 1,
  source: r.source, enabled: r.enabled === 1, note: r.note,
});

const parseModels = (s: string): string[] => {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const toUnrec = (r: UnrecRow): UnrecognizedError & { ruleId: string | null } => ({
  id: Number(r.id), fingerprint: r.fingerprint, sample: r.sample, count: Number(r.count), models: parseModels(r.models),
  firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen), status: r.status, category: (r.category as LimitKind | null) ?? null,
  signal: r.signal === "generic" || r.signal === "correlated" ? r.signal : "observed", ruleId: r.rule_id,
});

/** 模型路由的所有表（设计 addendum 第 4–6 节）。 */
export class RoutingRepo {
  constructor(private readonly db: Db) {}

  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn);
  }

  // ---- 注册表 ----
  registry(): RegistryModel[] {
    const rows = this.db.prepare(`SELECT * FROM model_registry ORDER BY position, name`).all() as unknown as {
      name: string; tier: Tier; enabled: number; account: string; price_in: number | null; price_out: number | null; note: string;
    }[];
    return rows.map((r) => ({ name: r.name, tier: r.tier, enabled: r.enabled === 1, account: r.account, priceIn: num(r.price_in), priceOut: num(r.price_out), note: r.note }));
  }

  /** 新的排到最后；已有的就地更新（位置不变）。 */
  upsertModel(m: RegistryModel): void {
    this.db
      .prepare(
        `INSERT INTO model_registry (name, tier, enabled, account, price_in, price_out, note, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM model_registry))
         ON CONFLICT(name) DO UPDATE SET tier = excluded.tier, enabled = excluded.enabled, account = excluded.account,
           price_in = excluded.price_in, price_out = excluded.price_out, note = excluded.note`,
      )
      .run(m.name, m.tier, m.enabled ? 1 : 0, m.account, m.priceIn, m.priceOut, m.note);
  }

  removeModel(name: string): void {
    this.db.prepare(`DELETE FROM model_registry WHERE name = ?`).run(name);
  }

  /** 和相邻的一个换位置。 */
  moveModel(name: string, delta: -1 | 1): void {
    this.transaction(() => {
      const list = this.registry().map((m) => m.name);
      const i = list.indexOf(name);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j]!, list[i]!];
      const st = this.db.prepare(`UPDATE model_registry SET position = ? WHERE name = ?`);
      list.forEach((n, k) => st.run(k, n));
    });
  }

  // ---- 降级链 ----
  chains(): Record<Tier, string[]> {
    const out: Record<Tier, string[]> = { high: [], mid: [], low: [] };
    const rows = this.db.prepare(`SELECT tier, model FROM model_chains ORDER BY tier, position`).all() as unknown as { tier: Tier; model: string }[];
    for (const r of rows) if (isTier(r.tier)) out[r.tier].push(r.model);
    return out;
  }

  setChain(tier: Tier, models: string[]): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM model_chains WHERE tier = ?`).run(tier);
      const st = this.db.prepare(`INSERT INTO model_chains (tier, position, model) VALUES (?, ?, ?)`);
      [...new Set(models)].forEach((m, i) => st.run(tier, i, m));
    });
  }

  // ---- 任务覆盖 ----
  taskRoutes(): TaskRouteOverride[] {
    const rows = this.db.prepare(`SELECT * FROM task_routes ORDER BY task`).all() as unknown as {
      task: string; tier: Tier | null; min_tier: Tier | null; policy: LimitPolicy | null; critical: number | null;
    }[];
    return rows.flatMap((r) =>
      isTaskId(r.task) ? [{ task: r.task, tier: r.tier, minTier: r.min_tier, policy: r.policy, critical: r.critical === null ? null : r.critical === 1 }] : [],
    );
  }

  setTaskRoute(o: TaskRouteOverride): void {
    this.db
      .prepare(
        `INSERT INTO task_routes (task, tier, min_tier, policy, critical) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task) DO UPDATE SET tier = excluded.tier, min_tier = excluded.min_tier, policy = excluded.policy, critical = excluded.critical`,
      )
      .run(o.task, o.tier ?? null, o.minTier ?? null, o.policy ?? null, o.critical === undefined || o.critical === null ? null : o.critical ? 1 : 0);
  }

  clearTaskRoute(task: TaskId): void {
    this.db.prepare(`DELETE FROM task_routes WHERE task = ?`).run(task);
  }

  // ---- 识别规则 ----
  /** 用户和学到的规则，以及内置规则的启用覆盖（source = builtin 的行只记 enabled）。 */
  rules(): LimitRule[] {
    return (this.db.prepare(`SELECT * FROM limit_rules ORDER BY created_at, id`).all() as unknown as RuleRow[]).map(toRule);
  }

  addRule(r: LimitRule, now: number): void {
    this.db
      .prepare(
        `INSERT INTO limit_rules (id, kind, pattern, category, account_level, source, enabled, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, pattern = excluded.pattern, category = excluded.category,
           account_level = excluded.account_level, source = excluded.source, enabled = excluded.enabled, note = excluded.note`,
      )
      .run(r.id, r.kind, r.pattern, r.category, r.accountLevel ? 1 : 0, r.source, r.enabled ? 1 : 0, r.note, now);
  }

  removeRule(id: string): void {
    this.db.prepare(`DELETE FROM limit_rules WHERE id = ?`).run(id);
  }

  setRuleEnabled(id: string, enabled: boolean): boolean {
    return Number(this.db.prepare(`UPDATE limit_rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id).changes) > 0;
  }

  // ---- 健康 ----
  health(): StoredHealth[] {
    return (this.db.prepare(`SELECT * FROM model_health ORDER BY model`).all() as unknown as HealthRow[]).map((r) => ({
      model: r.model, state: r.state, kind: (r.kind as LimitKind | null) ?? null, until: num(r.until), resetKnown: r.reset_known === 1,
      backoffStep: Number(r.backoff_step), hitAt: num(r.hit_at), suspected: r.suspected === 1, consecutiveFailures: Number(r.consecutive_failures),
      failureStreakSince: num(r.failure_streak_since), lastSuccessAt: num(r.last_success_at), lastFailureAt: num(r.last_failure_at), lastFailureText: r.last_failure_text,
    }));
  }

  saveHealth(h: StoredHealth, now: number): void {
    this.db
      .prepare(
        `INSERT INTO model_health (model, state, kind, until, reset_known, backoff_step, hit_at, suspected, consecutive_failures, failure_streak_since,
           last_success_at, last_failure_at, last_failure_text, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET state = excluded.state, kind = excluded.kind, until = excluded.until, reset_known = excluded.reset_known,
           backoff_step = excluded.backoff_step, hit_at = excluded.hit_at, suspected = excluded.suspected, consecutive_failures = excluded.consecutive_failures,
           failure_streak_since = excluded.failure_streak_since, last_success_at = excluded.last_success_at, last_failure_at = excluded.last_failure_at,
           last_failure_text = excluded.last_failure_text, updated_at = excluded.updated_at`,
      )
      .run(
        h.model, h.state, h.kind, h.until, h.resetKnown ? 1 : 0, h.backoffStep, h.hitAt, h.suspected ? 1 : 0, h.consecutiveFailures, h.failureStreakSince,
        h.lastSuccessAt, h.lastFailureAt, h.lastFailureText === null ? null : h.lastFailureText.slice(0, SAMPLE_MAX), now,
      );
  }

  deleteHealth(model: string): void {
    this.db.prepare(`DELETE FROM model_health WHERE model = ?`).run(model);
  }

  // ---- 未识别报错 ----
  /** 同一个指纹只记一行：次数 +1，补上模型。确认过 / 否认过的只更新次数和时间，不改状态。 */
  noteUnrecognized(x: { fingerprint: string; sample: string; model: string | null; signal: UnrecognizedError["signal"]; now: number }): UnrecognizedError & { ruleId: string | null } {
    return this.transaction(() => {
      const prev = this.unrecognizedByFingerprint(x.fingerprint);
      if (!prev) {
        this.db
          .prepare(`INSERT INTO unrecognized_errors (fingerprint, sample, count, models, first_seen, last_seen, signal) VALUES (?, ?, 1, ?, ?, ?, ?)`)
          .run(x.fingerprint, x.sample.slice(0, SAMPLE_MAX), JSON.stringify(x.model ? [x.model] : []), x.now, x.now, x.signal);
      } else {
        const models = x.model && !prev.models.includes(x.model) ? [...prev.models, x.model].slice(-20) : prev.models;
        // 更强的信号盖过弱的：observed < generic < correlated。
        const rank = (s: string) => (s === "correlated" ? 2 : s === "generic" ? 1 : 0);
        const signal = rank(x.signal) > rank(prev.signal) ? x.signal : prev.signal;
        this.db
          .prepare(`UPDATE unrecognized_errors SET count = count + 1, models = ?, last_seen = ?, signal = ? WHERE id = ?`)
          .run(JSON.stringify(models), x.now, signal, prev.id);
      }
      return this.unrecognizedByFingerprint(x.fingerprint)!;
    });
  }

  unrecognizedByFingerprint(fp: string): (UnrecognizedError & { ruleId: string | null }) | null {
    const r = this.db.prepare(`SELECT * FROM unrecognized_errors WHERE fingerprint = ?`).get(fp) as unknown as UnrecRow | undefined;
    return r ? toUnrec(r) : null;
  }

  unrecognizedById(id: number): (UnrecognizedError & { ruleId: string | null }) | null {
    const r = this.db.prepare(`SELECT * FROM unrecognized_errors WHERE id = ?`).get(id) as unknown as UnrecRow | undefined;
    return r ? toUnrec(r) : null;
  }

  unrecognized(limit = 100): UnrecognizedError[] {
    const rows = this.db.prepare(`SELECT * FROM unrecognized_errors ORDER BY status = 'open' DESC, last_seen DESC LIMIT ?`).all(limit) as unknown as UnrecRow[];
    return rows.map((r) => {
      const u: Partial<ReturnType<typeof toUnrec>> & UnrecognizedError = toUnrec(r);
      // 规则 id 只在主进程里用。
      delete u.ruleId;
      return u;
    });
  }

  setUnrecognizedStatus(id: number, status: UnrecognizedStatus, category: LimitKind | null, ruleId: string | null): void {
    this.db.prepare(`UPDATE unrecognized_errors SET status = ?, category = ?, rule_id = ? WHERE id = ?`).run(status, category, ruleId, id);
  }

  // ---- 事件 ----
  addEvent(e: { at: number; kind: RouteEventKind; task?: string | null; model?: string | null; toModel?: string | null; detail?: string | null }): void {
    this.db
      .prepare(`INSERT INTO route_events (at, kind, task, model, to_model, detail) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(e.at, e.kind, e.task ?? null, e.model ?? null, e.toModel ?? null, e.detail === undefined || e.detail === null ? null : e.detail.slice(0, 500));
  }

  events(limit = 200): RouteEvent[] {
    const rows = this.db.prepare(`SELECT * FROM route_events ORDER BY at DESC, id DESC LIMIT ?`).all(limit) as unknown as {
      id: number; at: number; kind: RouteEventKind; task: string | null; model: string | null; to_model: string | null; detail: string | null;
    }[];
    return rows.map((r) => ({ id: Number(r.id), at: Number(r.at), kind: r.kind, task: r.task, model: r.model, toModel: r.to_model, detail: r.detail }));
  }

  /** at 之后的某类事件数。 */
  countEvents(kinds: RouteEventKind[], sinceMs: number): number {
    if (kinds.length === 0) return 0;
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM route_events WHERE at >= ? AND kind IN (${kinds.map(() => "?").join(",")})`)
      .get(sinceMs, ...kinds) as { n: number };
    return Number(r.n);
  }

  pruneEvents(now: number): void {
    this.db.prepare(`DELETE FROM route_events WHERE at < ?`).run(now - EVENTS_KEEP_MS);
  }
}

