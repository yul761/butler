import type { PolicyScope } from "../../shared/admission-policy";
import {
  STACK_POLICY_DEFAULTS, STACK_POLICY_KEYS, parseStackOverrides, sanitizeStackOverrides,
  type StackPolicy, type StackPolicyKeyView, type StackPolicyLayer, type StackPolicyOverrides, type StackPolicyView,
} from "../../shared/stacks";
import type { Db } from "../db/database";
import { LayeredResolver, type ScopeRef } from "../scope/layered";

export interface StackPolicyDeps {
  db: Db;
  productsOf: (slug: string) => { id: number; name: string }[];
  productName: (id: number) => string | null;
  now: () => number;
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

/** 栈策略的三层配置（契约 4.2）：存在 stack_policies，经 LayeredResolver 解析。 */
export class StackPolicyService {
  readonly resolver: LayeredResolver<StackPolicy>;

  constructor(private readonly d: StackPolicyDeps) {
    this.resolver = new LayeredResolver<StackPolicy>({
      defaults: STACK_POLICY_DEFAULTS,
      read: (ref) => {
        const r = this.row(ref);
        return r ? sanitizeStackOverrides(parse(r.overrides)) : null;
      },
      productsOf: d.productsOf,
      productName: d.productName,
    });
  }

  private row(ref: ScopeRef): { id: number; overrides: string } | null {
    const [w, args] = where(ref);
    return (this.d.db.prepare(`SELECT id, overrides FROM stack_policies WHERE ${w}`).get(...args) as { id: number; overrides: string } | undefined) ?? null;
  }

  /** 这一层在 stack_policies 里的行 id（导入的批次记录用）。 */
  rowId(ref: ScopeRef): number | null {
    return this.row(ref)?.id ?? null;
  }

  overrides(ref: ScopeRef): StackPolicyOverrides {
    const r = this.row(ref);
    return r ? sanitizeStackOverrides(parse(r.overrides)) : {};
  }

  /** 仓库 slug 不知道时按全局。 */
  forSlug(slug: string | null): StackPolicy {
    return slug ? this.resolver.forRepo(slug).value : this.resolver.forGlobal().value;
  }

  /**
   * autoRebase 在仓库或产品层明确关着（BTL-278）：epic 选了半自动也不打开。全局层不算，全局档位写的就是它。
   */
  autoRebaseExplicitOff(slug: string | null): boolean {
    if (!slug) return false;
    const r = this.resolver.forRepo(slug);
    const o = r.origin.autoRebase;
    return r.value.autoRebase === false && !!o && o !== "default" && (o.kind === "repo" || o.kind === "product");
  }

  /** 这个仓库属于这个产品。 */
  inProduct(slug: string | null, productId: number): boolean {
    return !!slug && this.d.productsOf(slug).some((p) => p.id === productId);
  }

  /** 有没有哪一层开了 autoRebase（都没开时 tick 不用 fetch）。 */
  anyAutoRebase(): boolean {
    const rows = this.d.db.prepare(`SELECT overrides FROM stack_policies`).all() as { overrides: string }[];
    return STACK_POLICY_DEFAULTS.autoRebase || rows.some((r) => sanitizeStackOverrides(parse(r.overrides)).autoRebase === true);
  }

  /** 把一层整个换成 overrides（校验过，不合法抛 StackPolicyError）。空的一层删掉。 */
  setLayer(ref: ScopeRef, raw: unknown, at?: number): void {
    const overrides = parseStackOverrides(raw);
    const json = JSON.stringify(Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : 1))));
    const now = at ?? this.d.now();
    const ex = this.row(ref);
    if (Object.keys(overrides).length === 0) {
      if (ex) this.d.db.prepare(`DELETE FROM stack_policies WHERE id = ?`).run(ex.id);
    } else if (ex) {
      this.d.db.prepare(`UPDATE stack_policies SET overrides = ?, updated_at = ? WHERE id = ?`).run(json, now, ex.id);
    } else {
      this.d.db
        .prepare(`INSERT INTO stack_policies (scope_kind, product_id, repo_slug, overrides, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run(ref.kind, ref.kind === "product" ? ref.productId : null, ref.kind === "repo" ? ref.slug : null, json, now);
    }
    this.d.onChange?.();
  }

  view(scope: PolicyScope): StackPolicyView {
    const r = this.resolver.resolve(scope);
    const own = this.overrides(scope);
    const keys: StackPolicyKeyView[] = STACK_POLICY_KEYS.map((key) => {
      const o = r.origin[key];
      const origin: StackPolicyKeyView["origin"] =
        !o || o === "default"
          ? { kind: "default" }
          : o.kind === "product"
            ? { kind: "product", productId: o.productId, name: this.d.productName(o.productId) ?? `#${o.productId}` }
            : o;
      const set = Object.prototype.hasOwnProperty.call(own, key);
      return { key, effective: r.value[key], origin, set, override: set ? (own[key] ?? null) : null };
    });
    return { scope, keys };
  }

  layers(): StackPolicyLayer[] {
    const rows = this.d.db.prepare(`SELECT scope_kind, product_id, repo_slug, overrides FROM stack_policies ORDER BY scope_kind, product_id, repo_slug`).all() as {
      scope_kind: string; product_id: number | null; repo_slug: string | null; overrides: string;
    }[];
    return rows.map((r) => {
      const scope: PolicyScope = r.scope_kind === "global" ? { kind: "global" } : r.scope_kind === "product" ? { kind: "product", productId: Number(r.product_id) } : { kind: "repo", slug: String(r.repo_slug) };
      const label = scope.kind === "global" ? "global" : scope.kind === "product" ? (this.d.productName(scope.productId) ?? `#${scope.productId}`) : scope.slug;
      return { scope, label, overrides: sanitizeStackOverrides(parse(r.overrides)) };
    });
  }
}
