import type { Db } from "../db/database";
import { LayeredResolver, type ScopeRef } from "../scope/layered";
import {
  BUILTIN_RISK_PATHS, expandPrPolicy, PR_POLICY_DEFAULTS, PR_POLICY_KEYS, parsePrOverrides, RISK_PATH_CLASSES, sanitizePrOverrides,
  type PrKeyView, type PrPolicy, type PrPolicyKey, type PrPolicyOverrides, type PrPolicyView, type PrScope, type PrValue,
  type ResolvedPrPolicy, type RiskPathClass,
} from "../../shared/pr-policy";

export interface PrPoliciesDeps {
  db: Db;
  products: { productsOf(slug: string): { id: number; name: string }[]; product(id: number): { name: string } | null };
  now: () => number;
}

interface PolicyRow { id: number; overrides: string }

const where = (ref: ScopeRef): [string, (string | number)[]] =>
  ref.kind === "global"
    ? [`scope_kind = 'global'`, []]
    : ref.kind === "product"
      ? [`scope_kind = 'product' AND product_id = ?`, [ref.productId]]
      : [`scope_kind = 'repo' AND repo_slug = ?`, [ref.slug]];

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** 就绪度、证据、风险的三层策略（契约 4.2，设计 §6）：存在 pr_policies，经 LayeredResolver 解析。 */
export class PrPolicies {
  readonly resolver: LayeredResolver<PrPolicy>;
  private listeners: (() => void)[] = [];

  constructor(private readonly d: PrPoliciesDeps) {
    this.resolver = new LayeredResolver<PrPolicy>({
      defaults: PR_POLICY_DEFAULTS,
      read: (ref) => {
        const row = this.row(ref);
        return row ? (sanitizePrOverrides(parse(row.overrides)) as Partial<PrPolicy>) : null;
      },
      productsOf: (slug) => d.products.productsOf(slug),
      productName: (id) => d.products.product(id)?.name ?? null,
    });
  }

  private row(ref: ScopeRef): PolicyRow | null {
    const [w, args] = where(ref);
    return (this.d.db.prepare(`SELECT id, overrides FROM pr_policies WHERE ${w}`).get(...args) as PolicyRow | undefined) ?? null;
  }

  /** 策略变了（就绪和风险要重算）。 */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** 路径类别各层（全局 → 产品 → 仓库）额外 glob 的并集。 */
  unions(ref: ScopeRef): Record<RiskPathClass, string[]> {
    const out = Object.fromEntries(RISK_PATH_CLASSES.map((c) => [c, [] as string[]])) as Record<RiskPathClass, string[]>;
    for (const layer of this.resolver.layersFor(ref)) {
      const v = layer.values as Record<string, unknown>;
      for (const c of RISK_PATH_CLASSES) {
        const list = v[`risk.paths.${c}`];
        if (Array.isArray(list)) for (const g of list) if (typeof g === "string" && !out[c].includes(g)) out[c].push(g);
      }
    }
    return out;
  }

  /** 一个仓库生效的策略（展开后）；认不出仓库只用全局层。 */
  forSlug(slug: string | null): ResolvedPrPolicy {
    const ref: ScopeRef = slug ? { kind: "repo", slug } : { kind: "global" };
    return expandPrPolicy(this.resolver.resolve(ref).value, this.unions(ref));
  }

  overrides(ref: ScopeRef): PrPolicyOverrides {
    const r = this.row(ref);
    return r ? sanitizePrOverrides(parse(r.overrides)) : {};
  }

  /** 所有层（导出用）。 */
  allLayers(): { ref: PrScope; overrides: PrPolicyOverrides }[] {
    const rows = this.d.db.prepare(`SELECT scope_kind, product_id, repo_slug, overrides FROM pr_policies ORDER BY id`).all() as {
      scope_kind: string; product_id: number | null; repo_slug: string | null; overrides: string;
    }[];
    return rows.map((r) => ({
      ref: r.scope_kind === "global" ? { kind: "global" } : r.scope_kind === "product" ? { kind: "product", productId: r.product_id! } : { kind: "repo", slug: r.repo_slug! },
      overrides: sanitizePrOverrides(parse(r.overrides)),
    }));
  }

  /** 把一层的覆盖整个换成 raw（校验过；不合法抛 PrPolicyError）。 */
  setLayer(ref: PrScope, raw: unknown): void {
    if (ref.kind === "product" && !this.d.products.product(ref.productId)) throw new Error("product not found");
    const overrides = parsePrOverrides(raw);
    const json = JSON.stringify(Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : 1))));
    const now = this.d.now();
    const existing = this.row(ref);
    if (existing) {
      this.d.db.prepare(`UPDATE pr_policies SET overrides = ?, updated_at = ? WHERE id = ?`).run(json, now, existing.id);
    } else if (Object.keys(overrides).length > 0) {
      this.d.db
        .prepare(`INSERT INTO pr_policies (scope_kind, product_id, repo_slug, overrides, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run(ref.kind, ref.kind === "product" ? ref.productId : null, ref.kind === "repo" ? ref.slug : null, json, now);
    } else {
      return;
    }
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // 监听方自己的错不影响保存。
      }
    }
  }

  view(scope: PrScope): PrPolicyView {
    const r = this.resolver.resolve(scope);
    const own = this.overrides(scope) as Record<string, PrValue | undefined>;
    const keys: PrKeyView[] = PR_POLICY_KEYS.map((def) => {
      const key = def.key as PrPolicyKey;
      const o = r.origin[key];
      const origin: PrKeyView["origin"] =
        !o || o === "default"
          ? { kind: "default" }
          : o.kind === "product"
            ? { kind: "product", productId: o.productId, name: this.d.products.product(o.productId)?.name ?? `#${o.productId}` }
            : o;
      return { key, group: def.group, effective: (r.value as Record<string, PrValue>)[key], origin, override: own[key] ?? null };
    });
    const conflicts = scope.kind === "repo"
      ? this.resolver.conflicts(scope.slug)
          .filter((c) => !c.key.startsWith("risk.paths.") || c.key.endsWith(".builtin"))
          .map((c) => ({ key: c.key, products: c.products.map((p) => ({ ...p, value: p.value as PrValue })) }))
      : [];
    return { scope, keys, builtinPaths: BUILTIN_RISK_PATHS, unions: this.unions(scope), conflicts };
  }
}
