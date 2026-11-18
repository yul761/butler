import type { Db } from "../db/database";
import type { LessonsRepo } from "../db/lessons-repo";
import type { BatchRecorder } from "../batches/batch-recorder";
import { LayeredResolver, type Resolved, type ScopeRef } from "../scope/layered";
import {
  ADMISSION_POLICY_DEFAULTS, ADMISSION_POLICY_KEYS, parsePolicyOverrides, sanitizePolicyOverrides,
  type AdmissionPolicy, type AdmissionPolicyKey, type AdmissionPolicyOverrides, type AdmissionPolicyView, type PolicyScope, type PolicyValue,
} from "../../shared/admission-policy";
import type { BatchOrigin } from "../../shared/batches";

export interface AdmissionPolicyDeps {
  db: Db;
  repo: LessonsRepo;
  recorder: BatchRecorder;
  /** 策略版本（设置 admissionPolicyVersion）：每次改动加一，D 写进 score_policy_version。 */
  version: { get(): number; set(v: number): void };
  /** 校准过没有（校准界面属于 D；没有它之前一直是 false）。 */
  calibrated?: () => boolean;
  now: () => number;
}

interface PolicyRow { id: number; overrides: string }

const where = (ref: ScopeRef): [string, (string | number)[]] =>
  ref.kind === "global"
    ? [`scope_kind = 'global'`, []]
    : ref.kind === "product"
      ? [`scope_kind = 'product' AND product_id = ?`, [ref.productId]]
      : [`scope_kind = 'repo' AND repo_slug = ?`, [ref.slug]];

/** 三层准入策略：存在 admission_policies，经 LayeredResolver 解析（契约 4.2）。改动记成 policy 批次，可撤销。 */
export class AdmissionPolicyService {
  readonly resolver: LayeredResolver<AdmissionPolicy>;

  constructor(private readonly d: AdmissionPolicyDeps) {
    this.resolver = new LayeredResolver<AdmissionPolicy>({
      defaults: ADMISSION_POLICY_DEFAULTS,
      read: (ref) => {
        const row = this.row(ref);
        return row ? (sanitizePolicyOverrides(parse(row.overrides)) as Partial<AdmissionPolicy>) : null;
      },
      productsOf: (slug) => d.repo.productsOf(slug),
      productName: (id) => d.repo.product(id)?.name ?? null,
    });
  }

  private row(ref: ScopeRef): PolicyRow | null {
    const [w, args] = where(ref);
    return (this.d.db.prepare(`SELECT id, overrides FROM admission_policies WHERE ${w}`).get(...args) as PolicyRow | undefined) ?? null;
  }

  version(): number {
    return this.d.version.get();
  }

  /** 这一层自己设的覆盖。 */
  overrides(ref: ScopeRef): AdmissionPolicyOverrides {
    const r = this.row(ref);
    return r ? sanitizePolicyOverrides(parse(r.overrides)) : {};
  }

  /** 所有层（导出用）。 */
  allLayers(): { ref: ScopeRef; overrides: AdmissionPolicyOverrides }[] {
    const rows = this.d.db.prepare(`SELECT scope_kind, product_id, repo_slug, overrides FROM admission_policies ORDER BY id`).all() as {
      scope_kind: string; product_id: number | null; repo_slug: string | null; overrides: string;
    }[];
    return rows.map((r) => ({
      ref: r.scope_kind === "global" ? { kind: "global" } : r.scope_kind === "product" ? { kind: "product", productId: Number(r.product_id) } : { kind: "repo", slug: String(r.repo_slug) },
      overrides: sanitizePolicyOverrides(parse(r.overrides)),
    }));
  }

  resolve(ref: ScopeRef): Resolved<AdmissionPolicy> {
    return this.resolver.resolve(ref);
  }

  /** 把一层的覆盖整个换成 overrides（校验过）；记成一个批次，版本加一。没变化不记。 */
  setLayer(ref: ScopeRef, raw: unknown, opts: { origin?: BatchOrigin; kind?: string } = {}): { batchId: number | null; version: number } {
    if (ref.kind === "product" && !this.d.repo.product(ref.productId)) throw new Error("product not found");
    const overrides = parsePolicyOverrides(raw);
    const now = this.d.now();
    const { outcome } = this.d.recorder.run(
      { kind: opts.kind ?? "policy", origin: opts.origin ?? "manual", entity: "policy", scope: { layer: ref }, now },
      (ctx) => this.write(ctx, ref, overrides, now),
    );
    if (outcome.batchId !== null) this.d.version.set(this.version() + 1);
    return { batchId: outcome.batchId, version: this.version() };
  }

  /** 在一个已经开着的批次里写一层（导入用）。 */
  write(ctx: { track(e: string, id: number): void; created(e: string, id: number): void }, ref: ScopeRef, overrides: AdmissionPolicyOverrides, now: number): void {
    const existing = this.row(ref);
    const json = JSON.stringify(Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : 1))));
    if (existing) {
      ctx.track("policy", existing.id);
      this.d.db.prepare(`UPDATE admission_policies SET overrides = ?, updated_at = ? WHERE id = ?`).run(json, now, existing.id);
      return;
    }
    if (Object.keys(overrides).length === 0) return;
    const id = Number(
      this.d.db
        .prepare(`INSERT INTO admission_policies (scope_kind, product_id, repo_slug, overrides, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run(ref.kind, ref.kind === "product" ? ref.productId : null, ref.kind === "repo" ? ref.slug : null, json, now).lastInsertRowid,
    );
    ctx.created("policy", id);
  }

  /** 导入改了策略之后调用：版本加一。 */
  bumpVersion(): number {
    this.d.version.set(this.version() + 1);
    return this.version();
  }

  view(scope: PolicyScope): AdmissionPolicyView {
    const r = this.resolve(scope);
    const own = this.overrides(scope);
    const keys = ADMISSION_POLICY_KEYS.map((def) => {
      const key = def.key as AdmissionPolicyKey;
      const o = r.origin[key];
      const origin: AdmissionPolicyView["keys"][number]["origin"] =
        !o || o === "default"
          ? { kind: "default" }
          : o.kind === "product"
            ? { kind: "product", productId: o.productId, name: this.d.repo.product(o.productId)?.name ?? `#${o.productId}` }
            : o;
      return { key, effective: r.value[key], origin, override: (own[key] as PolicyValue | undefined) ?? null };
    });
    const conflicts = scope.kind === "repo"
      ? this.resolver.conflicts(scope.slug).map((c) => ({ key: c.key, products: c.products.map((p) => ({ ...p, value: p.value as PolicyValue })) }))
      : [];
    return { scope, keys, conflicts, version: this.version(), calibrated: this.d.calibrated?.() ?? false };
  }
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
