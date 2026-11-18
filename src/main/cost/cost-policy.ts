import {
  COST_POLICY_DEFAULTS, COST_POLICY_KEYS, parseCostOverrides, sanitizeCostOverrides,
  type CostPolicy, type CostPolicyKeyView, type CostPolicyOverrides, type CostPolicyValue, type CostPolicyView,
} from "../../shared/cost";
import type { PolicyScope } from "../../shared/admission-policy";
import type { Db } from "../db/database";
import { LayeredResolver, type ScopeRef } from "../scope/layered";

export interface CostPolicyDeps {
  db: Db;
  productsOf: (slug: string) => { id: number; name: string }[];
  productName: (id: number) => string | null;
  now: () => number;
  /** 改了某一层（熔断重新看一遍）。 */
  onChange?: () => void;
}

const where = (ref: ScopeRef): [string, (string | number)[]] =>
  ref.kind === "global"
    ? [`scope_kind = 'global'`, []]
    : ref.kind === "product"
      ? [`scope_kind = 'product' AND product_id = ?`, [ref.productId]]
      : [`scope_kind = 'repo' AND repo_slug = ?`, [ref.slug]];

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

/** null（不限）比任何数都宽。 */
const minCap = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** 多个仓库（一个 ticket 跨了几个仓库）：每个字段取最严的。单位不同的上限没法比，只取和第一个仓库同单位的。 */
export function strictest(policies: readonly CostPolicy[]): CostPolicy {
  if (policies.length === 0) return { ...COST_POLICY_DEFAULTS };
  const unit = policies[0]!.unit;
  const same = policies.filter((p) => p.unit === unit);
  return {
    unit,
    sessionCap: same.reduce<number | null>((m, p) => minCap(m, p.sessionCap), null),
    ticketCap: same.reduce<number | null>((m, p) => minCap(m, p.ticketCap), null),
    action: policies.some((p) => p.action === "pause") ? "pause" : "downgrade_then_pause",
    pauseScope: policies.some((p) => p.pauseScope === "session") ? "session" : "background",
    graceAfterDowngradePercent: Math.min(...policies.map((p) => p.graceAfterDowngradePercent)),
    raisePercent: Math.min(...policies.map((p) => p.raisePercent)),
  };
}

/** 花费上限的三层配置（契约 4.2）：存在 cost_caps，经 LayeredResolver 解析。 */
export class CostPolicyService {
  readonly resolver: LayeredResolver<CostPolicy>;

  constructor(private readonly d: CostPolicyDeps) {
    this.resolver = new LayeredResolver<CostPolicy>({
      defaults: COST_POLICY_DEFAULTS,
      read: (ref) => {
        const r = this.row(ref);
        return r ? sanitizeCostOverrides(parse(r.overrides)) : null;
      },
      productsOf: d.productsOf,
      productName: d.productName,
    });
  }

  private row(ref: ScopeRef): { id: number; overrides: string } | null {
    const [w, args] = where(ref);
    return (this.d.db.prepare(`SELECT id, overrides FROM cost_caps WHERE ${w}`).get(...args) as { id: number; overrides: string } | undefined) ?? null;
  }

  overrides(ref: ScopeRef): CostPolicyOverrides {
    const r = this.row(ref);
    return r ? sanitizeCostOverrides(parse(r.overrides)) : {};
  }

  /** 这几个仓库下的 session / ticket 用的策略：没有仓库按全局，几个仓库取最严的。 */
  forRepos(slugs: readonly string[]): CostPolicy {
    const uniq = [...new Set(slugs)].sort();
    if (uniq.length === 0) return this.resolver.forGlobal().value;
    return strictest(uniq.map((s) => this.resolver.forRepo(s).value));
  }

  /** 有没有哪一层设了上限（都没设时熔断什么都不用算）。 */
  anyCap(): boolean {
    const rows = this.d.db.prepare(`SELECT overrides FROM cost_caps`).all() as { overrides: string }[];
    return rows.some((r) => {
      const o = sanitizeCostOverrides(parse(r.overrides));
      return typeof o.sessionCap === "number" || typeof o.ticketCap === "number";
    });
  }

  /** 把一层整个换成 overrides（校验过，不合法抛 CostPolicyError）。空的一层删掉。 */
  setLayer(ref: ScopeRef, raw: unknown): void {
    const overrides = parseCostOverrides(raw);
    const json = JSON.stringify(Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : 1))));
    const now = this.d.now();
    const ex = this.row(ref);
    if (Object.keys(overrides).length === 0) {
      if (ex) this.d.db.prepare(`DELETE FROM cost_caps WHERE id = ?`).run(ex.id);
    } else if (ex) {
      this.d.db.prepare(`UPDATE cost_caps SET overrides = ?, updated_at = ? WHERE id = ?`).run(json, now, ex.id);
    } else {
      this.d.db
        .prepare(`INSERT INTO cost_caps (scope_kind, product_id, repo_slug, overrides, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run(ref.kind, ref.kind === "product" ? ref.productId : null, ref.kind === "repo" ? ref.slug : null, json, now);
    }
    this.d.onChange?.();
  }

  /** 设置页：这一层每个键的生效值、谁设的、这一层自己设了什么。 */
  view(scope: PolicyScope): CostPolicyView {
    const r = this.resolver.resolve(scope);
    const own = this.overrides(scope);
    const keys: CostPolicyKeyView[] = COST_POLICY_KEYS.map((key) => {
      const o = r.origin[key];
      const origin: CostPolicyKeyView["origin"] =
        !o || o === "default"
          ? { kind: "default" }
          : o.kind === "product"
            ? { kind: "product", productId: o.productId, name: this.d.productName(o.productId) ?? `#${o.productId}` }
            : o;
      const set = Object.prototype.hasOwnProperty.call(own, key);
      return { key, effective: r.value[key], origin, set, override: set ? (own[key] as CostPolicyValue) : null };
    });
    return { scope, keys };
  }

  /** 设了覆盖的所有层（设置页的「已设置」列表）。 */
  layers(): { scope: PolicyScope; label: string; overrides: CostPolicyOverrides }[] {
    const rows = this.d.db.prepare(`SELECT scope_kind, product_id, repo_slug, overrides FROM cost_caps ORDER BY scope_kind, product_id, repo_slug`).all() as {
      scope_kind: string; product_id: number | null; repo_slug: string | null; overrides: string;
    }[];
    return rows.map((r) => {
      const scope: PolicyScope = r.scope_kind === "global" ? { kind: "global" } : r.scope_kind === "product" ? { kind: "product", productId: Number(r.product_id) } : { kind: "repo", slug: String(r.repo_slug) };
      const label = scope.kind === "global" ? "global" : scope.kind === "product" ? (this.d.productName(scope.productId) ?? `#${scope.productId}`) : scope.slug;
      return { scope, label, overrides: sanitizeCostOverrides(parse(r.overrides)) };
    });
  }
}
