import {
  INTAKE_POLICY_DEFAULTS, INTAKE_POLICY_KEYS, parseIntakeOverrides, sanitizeIntakeOverrides,
  type IntakePolicy, type IntakePolicyKeyView, type IntakePolicyOverrides, type IntakePolicyValue, type IntakePolicyView,
} from "../../shared/intake";
import type { PolicyScope } from "../../shared/admission-policy";
import type { Db } from "../db/database";
import { LayeredResolver, type ScopeRef } from "../scope/layered";

export interface IntakePolicyDeps {
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

/** 自动接活的三层策略（契约 4.2）：存在 intake_policies，经 LayeredResolver 解析。和 CostPolicyService 同一个写法。 */
export class IntakePolicyService {
  readonly resolver: LayeredResolver<IntakePolicy>;

  constructor(private readonly d: IntakePolicyDeps) {
    this.resolver = new LayeredResolver<IntakePolicy>({
      defaults: INTAKE_POLICY_DEFAULTS,
      read: (ref) => {
        const r = this.row(ref);
        return r ? sanitizeIntakeOverrides(parse(r.overrides)) : null;
      },
      productsOf: d.productsOf,
      productName: d.productName,
    });
  }

  private row(ref: ScopeRef): { id: number; overrides: string } | null {
    const [w, args] = where(ref);
    return (this.d.db.prepare(`SELECT id, overrides FROM intake_policies WHERE ${w}`).get(...args) as { id: number; overrides: string } | undefined) ?? null;
  }

  overrides(ref: ScopeRef): IntakePolicyOverrides {
    const r = this.row(ref);
    return r ? sanitizeIntakeOverrides(parse(r.overrides)) : {};
  }

  /** 这个仓库的策略；没有 slug（不是 GitHub 仓库）按全局。 */
  forSlug(slug: string | null): IntakePolicy {
    return slug ? this.resolver.forRepo(slug).value : this.resolver.forGlobal().value;
  }

  /** 有没有哪一层把 enabled 打开（都没开时不拉取、什么都不做）。 */
  anyEnabled(): boolean {
    const rows = this.d.db.prepare(`SELECT overrides FROM intake_policies`).all() as { overrides: string }[];
    return rows.some((r) => sanitizeIntakeOverrides(parse(r.overrides)).enabled === true);
  }

  /** 把一层整个换成 overrides（校验过，不合法抛 IntakePolicyError）。空的一层删掉。 */
  setLayer(ref: ScopeRef, raw: unknown): void {
    const overrides = parseIntakeOverrides(raw);
    const json = JSON.stringify(Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : 1))));
    const now = this.d.now();
    const ex = this.row(ref);
    if (Object.keys(overrides).length === 0) {
      if (ex) this.d.db.prepare(`DELETE FROM intake_policies WHERE id = ?`).run(ex.id);
    } else if (ex) {
      this.d.db.prepare(`UPDATE intake_policies SET overrides = ?, updated_at = ? WHERE id = ?`).run(json, now, ex.id);
    } else {
      this.d.db
        .prepare(`INSERT INTO intake_policies (scope_kind, product_id, repo_slug, overrides, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run(ref.kind, ref.kind === "product" ? ref.productId : null, ref.kind === "repo" ? ref.slug : null, json, now);
    }
    this.d.onChange?.();
  }

  view(scope: PolicyScope): IntakePolicyView {
    const r = this.resolver.resolve(scope);
    const own = this.overrides(scope);
    const keys: IntakePolicyKeyView[] = INTAKE_POLICY_KEYS.map((key) => {
      const o = r.origin[key];
      const origin: IntakePolicyKeyView["origin"] =
        !o || o === "default"
          ? { kind: "default" }
          : o.kind === "product"
            ? { kind: "product", productId: o.productId, name: this.d.productName(o.productId) ?? `#${o.productId}` }
            : o;
      const set = Object.prototype.hasOwnProperty.call(own, key);
      return { key, effective: r.value[key], origin, set, override: set ? (own[key] as IntakePolicyValue) : null };
    });
    return { scope, keys, layers: this.layers() };
  }

  layers(): { scope: PolicyScope; label: string; overrides: IntakePolicyOverrides }[] {
    const rows = this.d.db.prepare(`SELECT scope_kind, product_id, repo_slug, overrides FROM intake_policies ORDER BY scope_kind, product_id, repo_slug`).all() as {
      scope_kind: string; product_id: number | null; repo_slug: string | null; overrides: string;
    }[];
    return rows.map((r) => {
      const scope: PolicyScope = r.scope_kind === "global" ? { kind: "global" } : r.scope_kind === "product" ? { kind: "product", productId: Number(r.product_id) } : { kind: "repo", slug: String(r.repo_slug) };
      const label = scope.kind === "global" ? "global" : scope.kind === "product" ? (this.d.productName(scope.productId) ?? `#${scope.productId}`) : scope.slug;
      return { scope, label, overrides: sanitizeIntakeOverrides(parse(r.overrides)) };
    });
  }
}
