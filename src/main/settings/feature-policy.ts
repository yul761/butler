/**
 * 设置 › 功能页要的策略状态（UI 重做 spec §5.3）：三张策略表各读一次，算出全局那一层的值，
 * 并列出仓库、产品层里改了功能开关的覆盖。一个用户可能有上百个仓库层，所以不逐层调 policyView。
 */
import type { PolicyScope } from "../../shared/admission-policy";
import { GOVERNED_POLICY_KEYS, type GovernedLayer } from "../../shared/automation";
import { FEATURE_POLICY_KEYS, POLICY_FAMILIES, policyGlobalKey, type FeaturePolicyState, type PolicyFamily, type PolicyOverrideEntry } from "../../shared/feature-rows";
import { sanitizeIntakeOverrides } from "../../shared/intake";
import { sanitizeLoopOverrides } from "../../shared/loop-policy";
import { sanitizeStackOverrides } from "../../shared/stacks";
import type { Db } from "../db/database";

const TABLE: Record<PolicyFamily, string> = { loop: "loop_policies", stacks: "stack_policies", intake: "intake_policies" };
const SANITIZE: Record<PolicyFamily, (raw: unknown) => object> = {
  loop: sanitizeLoopOverrides,
  stacks: sanitizeStackOverrides,
  intake: sanitizeIntakeOverrides,
};

interface Row {
  scope_kind: string;
  product_id: number | null;
  repo_slug: string | null;
  overrides: string;
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** 三张策略表的每一层：范围、名字和这一层自己设了的键（已校验）。 */
function eachLayer(db: Db, productName: (id: number) => string | null, visit: (family: PolicyFamily, scope: PolicyScope, label: string, own: Record<string, unknown>) => void): void {
  for (const family of POLICY_FAMILIES) {
    const rows = db.prepare(`SELECT scope_kind, product_id, repo_slug, overrides FROM ${TABLE[family]}`).all() as unknown as Row[];
    for (const r of rows) {
      let scope: PolicyScope | null = null;
      let label = "";
      if (r.scope_kind === "global") scope = { kind: "global" };
      else if (r.scope_kind === "product" && r.product_id !== null) {
        scope = { kind: "product", productId: r.product_id };
        label = productName(r.product_id) ?? `#${r.product_id}`;
      } else if (r.scope_kind === "repo" && r.repo_slug) {
        scope = { kind: "repo", slug: r.repo_slug };
        label = r.repo_slug;
      }
      if (!scope) continue;
      visit(family, scope, label, SANITIZE[family](parse(r.overrides)) as Record<string, unknown>);
    }
  }
}

export function readFeaturePolicy(db: Db, productName: (id: number) => string | null): FeaturePolicyState {
  const globals: Record<string, boolean> = {};
  const overrides: PolicyOverrideEntry[] = [];
  for (const family of POLICY_FAMILIES) for (const key of FEATURE_POLICY_KEYS[family]) globals[policyGlobalKey(family, key)] = false;
  eachLayer(db, productName, (family, scope, label, own) => {
    for (const key of FEATURE_POLICY_KEYS[family]) {
      const v = own[key];
      if (typeof v !== "boolean") continue;
      if (scope.kind === "global") globals[policyGlobalKey(family, key)] = v;
      else overrides.push({ family, key, scope, label, value: v });
    }
  });
  return { globals, overrides };
}

/** 自动化档位（BTL-247）的受管键在各层的值：只列设了受管键的层。 */
export function readGovernedLayers(db: Db, productName: (id: number) => string | null): GovernedLayer[] {
  const out: GovernedLayer[] = [];
  eachLayer(db, productName, (family, scope, label, own) => {
    const values: Record<string, unknown> = {};
    for (const key of GOVERNED_POLICY_KEYS[family]) if (Object.hasOwn(own, key)) values[key] = own[key];
    if (Object.keys(values).length > 0) out.push({ family, scope: scope.kind, label, values });
  });
  return out;
}
