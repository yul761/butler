import type { Db } from "../db/database";
import { LayeredResolver, type ScopeRef } from "../scope/layered";
import {
  LOOP_POLICY_DEFAULTS, LOOP_POLICY_KEYS, parseLoopOverrides, sanitizeLoopOverrides,
  type LoopPolicy, type LoopPolicyKey, type LoopPolicyOverrides, type LoopPolicyView, type LoopScope, type LoopValue,
} from "../../shared/loop-policy";

export interface LoopPoliciesDeps {
  db: Db;
  /** 仓库属于哪些产品、产品叫什么（lesson_products）。 */
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

/** 评论闭环和 CI 分类的三层策略（契约 4.2）：存在 loop_policies，经 LayeredResolver 解析。 */
export class LoopPolicies {
  readonly resolver: LayeredResolver<LoopPolicy>;

  constructor(private readonly d: LoopPoliciesDeps) {
    this.resolver = new LayeredResolver<LoopPolicy>({
      defaults: LOOP_POLICY_DEFAULTS,
      read: (ref) => {
        const row = this.row(ref);
        return row ? (sanitizeLoopOverrides(parse(row.overrides)) as Partial<LoopPolicy>) : null;
      },
      productsOf: (slug) => d.products.productsOf(slug),
      productName: (id) => d.products.product(id)?.name ?? null,
    });
  }

  private row(ref: ScopeRef): PolicyRow | null {
    const [w, args] = where(ref);
    return (this.d.db.prepare(`SELECT id, overrides FROM loop_policies WHERE ${w}`).get(...args) as PolicyRow | undefined) ?? null;
  }

  /** 一个仓库生效的策略；认不出仓库（slug 为 null）只用全局层。 */
  forSlug(slug: string | null): LoopPolicy {
    return this.resolver.resolve(slug ? { kind: "repo", slug } : { kind: "global" }).value;
  }

  overrides(ref: ScopeRef): LoopPolicyOverrides {
    const r = this.row(ref);
    return r ? sanitizeLoopOverrides(parse(r.overrides)) : {};
  }

  /** 有没有哪一层把这个总开关打开了（没打开时 PrWatcher 的钩子什么都不做，省掉每轮的解析）。 */
  anyEnabled(key: "comments.enabled" | "ci.enabled"): boolean {
    const rows = this.d.db.prepare(`SELECT overrides FROM loop_policies`).all() as { overrides: string }[];
    return rows.some((r) => (sanitizeLoopOverrides(parse(r.overrides)) as Record<string, unknown>)[key] === true);
  }

  /** 把一层的覆盖整个换成 raw（校验过；不合法抛 LoopPolicyError）。 */
  setLayer(ref: LoopScope, raw: unknown): void {
    if (ref.kind === "product" && !this.d.products.product(ref.productId)) throw new Error("product not found");
    const overrides = parseLoopOverrides(raw);
    const json = JSON.stringify(Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : 1))));
    const now = this.d.now();
    const existing = this.row(ref);
    if (existing) {
      this.d.db.prepare(`UPDATE loop_policies SET overrides = ?, updated_at = ? WHERE id = ?`).run(json, now, existing.id);
      return;
    }
    if (Object.keys(overrides).length === 0) return;
    this.d.db
      .prepare(`INSERT INTO loop_policies (scope_kind, product_id, repo_slug, overrides, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(ref.kind, ref.kind === "product" ? ref.productId : null, ref.kind === "repo" ? ref.slug : null, json, now);
  }

  view(scope: LoopScope): LoopPolicyView {
    const r = this.resolver.resolve(scope);
    const own = this.overrides(scope) as Record<string, LoopValue | undefined>;
    const keys = LOOP_POLICY_KEYS.map((def) => {
      const key = def.key as LoopPolicyKey;
      const o = r.origin[key];
      const origin: LoopPolicyView["keys"][number]["origin"] =
        !o || o === "default"
          ? { kind: "default" }
          : o.kind === "product"
            ? { kind: "product", productId: o.productId, name: this.d.products.product(o.productId)?.name ?? `#${o.productId}` }
            : o;
      return { key, effective: r.value[key] as LoopValue, origin, override: own[key] ?? null };
    });
    const conflicts = scope.kind === "repo"
      ? this.resolver.conflicts(scope.slug).map((c) => ({ key: c.key, products: c.products.map((p) => ({ ...p, value: p.value as LoopValue })) }))
      : [];
    return { scope, keys, conflicts };
  }
}
