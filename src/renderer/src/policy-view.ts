import {
  ADMISSION_POLICY_KEYS, checkPolicyValue, POLICY_GROUPS, type AdmissionPolicyOverrides, type AdmissionPolicyView, type PolicyGroup,
  type PolicyKeyDef, type PolicyKeyView, type PolicyScope, type PolicyValue,
} from "../../shared/admission-policy";

/** 编辑器里的草稿：键 → 输入框里的字。"" = 继承（这一层不设）。没出现的键 = 没改。 */
export type PolicyDraft = Record<string, string>;

const DEFS = new Map<string, PolicyKeyDef>(ADMISSION_POLICY_KEYS.map((d) => [d.key, d]));

/** 一个值写进输入框：布尔写成 "true" / "false"，没设写成 ""。 */
export const policyInputValue = (v: PolicyValue | null): string => (v === null ? "" : String(v));

/** 输入框里的字 → 值；"" = 继承。不合法时返回 undefined。 */
export function parsePolicyInput(key: string, raw: string): PolicyValue | null | undefined {
  const d = DEFS.get(key);
  if (!d) return undefined;
  const t = raw.trim();
  if (t === "") return null;
  let v: unknown = t;
  if (d.kind === "number" || d.kind === "int") v = Number(t);
  else if (d.kind === "bool") v = t === "true" ? true : t === "false" ? false : t;
  try {
    return checkPolicyValue(key, v);
  } catch {
    return undefined;
  }
}

/** 这一层的覆盖 + 草稿 → 要保存的整层；有不合法的值时给出第一个坏键。 */
export function policyOverridesFromDraft(view: AdmissionPolicyView, draft: PolicyDraft): { ok: true; overrides: AdmissionPolicyOverrides; changed: boolean } | { ok: false; badKey: string } {
  const out: Record<string, PolicyValue> = {};
  let changed = false;
  for (const k of view.keys) {
    const raw = draft[k.key];
    if (raw === undefined) {
      if (k.override !== null) out[k.key] = k.override;
      continue;
    }
    const v = parsePolicyInput(k.key, raw);
    if (v === undefined) return { ok: false, badKey: k.key };
    if (v !== k.override) changed = true;
    if (v !== null) out[k.key] = v;
  }
  return { ok: true, overrides: out as AdmissionPolicyOverrides, changed };
}

/** 按分组排好的键（分组顺序同总设计第 6 节）。 */
export function policyGroups(view: AdmissionPolicyView): { group: PolicyGroup; keys: (PolicyKeyView & { def: PolicyKeyDef })[] }[] {
  return POLICY_GROUPS.map((group) => ({
    group,
    keys: view.keys.flatMap((k) => {
      const def = DEFS.get(k.key);
      return def && def.group === group ? [{ ...k, def }] : [];
    }),
  })).filter((g) => g.keys.length > 0);
}

/** 下拉框的值 global / product:<id> / repo:<slug> 和层的互转。 */
export const policyScopeKey = (s: PolicyScope): string => (s.kind === "global" ? "global" : s.kind === "product" ? `product:${s.productId}` : `repo:${s.slug}`);
export function policyScopeFromKey(v: string): PolicyScope {
  if (v.startsWith("product:")) return { kind: "product", productId: Number(v.slice(8)) };
  if (v.startsWith("repo:")) return { kind: "repo", slug: v.slice(5) };
  return { kind: "global" };
}
