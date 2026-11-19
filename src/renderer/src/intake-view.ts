import {
  CLARIFY_MODES, CONFLICT_ACTIONS, INTAKE_RISKS, INTAKE_SIZES, parseIntakeOverrides,
  type IntakeAction, type IntakeItemView, type IntakeNoticeInfo, type IntakePolicyKey, type IntakePolicyOverrides, type IntakePolicyValue,
  type IntakePolicyView, type IntakeRecentEntry,
} from "../../shared/intake";
import { TIERS } from "../../shared/model-routing";
import type { UiStrings } from "./strings";

/** 下拉框的选项：布尔、大小、风险、模式、档位；没列的是数字（输入框）。 */
export const INTAKE_ENUMS: Partial<Record<IntakePolicyKey, readonly string[]>> = {
  enabled: ["true", "false"], autoStart: ["true", "false"], stackSubtasks: ["true", "false"],
  maxSize: INTAKE_SIZES, maxRisk: INTAKE_RISKS, conflictAction: CONFLICT_ACTIONS, clarifyMode: CLARIFY_MODES,
  tierSmall: TIERS, tierMedium: TIERS, tierLarge: TIERS, tierMediumRisk: TIERS, tierHighRisk: TIERS,
};

/** 编辑器的草稿：键 → 输入框里的字。"" = 继承。 */
export type IntakeDraft = Partial<Record<IntakePolicyKey, string>>;

export const intakeInputValue = (set: boolean, v: IntakePolicyValue | null): string => (set && v !== null ? String(v) : "");

/** 输入框里的字 → 值；"" 为继承（null），不合法为 undefined。 */
export function parseIntakeInput(key: IntakePolicyKey, raw: string): IntakePolicyValue | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  const v: unknown = t === "true" ? true : t === "false" ? false : INTAKE_ENUMS[key] ? t : Number(t);
  try {
    return parseIntakeOverrides({ [key]: v })[key] ?? undefined;
  } catch {
    return undefined;
  }
}

/** 这一层原来的覆盖 + 草稿 → 要保存的整层。 */
export function intakeOverridesFromDraft(view: IntakePolicyView, draft: IntakeDraft): { ok: true; overrides: IntakePolicyOverrides; changed: boolean } | { ok: false; badKey: string } {
  const out: Record<string, IntakePolicyValue> = {};
  let changed = false;
  for (const k of view.keys) {
    const raw = draft[k.key];
    if (raw === undefined) {
      if (k.set && k.override !== null) out[k.key] = k.override;
      continue;
    }
    const v = parseIntakeInput(k.key, raw);
    if (v === undefined) return { ok: false, badKey: k.key };
    if (v === null) {
      if (k.set) changed = true;
      continue;
    }
    if (!k.set || v !== k.override) changed = true;
    out[k.key] = v;
  }
  return { ok: true, overrides: out as IntakePolicyOverrides, changed };
}

/** 一个值给人看：布尔写开 / 关，枚举查表。 */
export function intakeValueText(v: IntakePolicyValue, S: UiStrings): string {
  if (typeof v === "boolean") return S.policyBool(v);
  if (typeof v === "number") return String(v);
  return S.ik.option[v] ?? v;
}

/** 「现在」页一条接活提醒的文字。 */
export function intakeNoticeText(n: IntakeNoticeInfo, S: UiStrings): string {
  const who = S.ik.who(n.key, n.title);
  switch (n.state) {
    case "needs_repo": return S.ik.noticeRepo(who);
    case "needs_clarification": return S.ik.noticeClarify(who, missingText(n.detail, S));
    case "needs_decision": return S.ik.noticeDecision(who);
    case "failed": return S.ik.noticeFailed(who, n.detail ?? "");
    default: return S.ik.noticeConflict(who, n.detail ?? "");
  }
}

/** detail 里的缺项（逗号分隔的 IntakeMissing）→ 人话。 */
export function missingText(detail: string | null, S: UiStrings): string {
  const parts = (detail ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts.map((p) => S.ik.missing[p] ?? p).join(S.ik.sep);
}

/** 提醒上的按钮：拿不准的、缺信息的可以直接开工；都能不做；同路径冲突可以照样并行。 */
export function intakeNoticeActions(n: IntakeNoticeInfo): ("intake" | "intakeStart" | "intakeSkip" | "intakeParallel")[] {
  if (n.state === "needs_decision" || n.state === "needs_clarification") return ["intakeStart", "intakeSkip", "intake"];
  if (n.state === "waiting") return ["intakeParallel", "intake"];
  return ["intake"];
}

/** 队列一行上能点的操作。 */
export function intakeItemActions(i: IntakeItemView): IntakeAction["op"][] {
  switch (i.state) {
    case "started": case "split": case "exists": return [];
    case "skipped": return ["start"];
    case "failed": return ["retry", "skip"];
    case "needs_repo": return ["setRepo", "skip"];
    case "needs_clarification": return ["clarified", "start", "skip"];
    case "waiting": return i.waitReason === "conflict" && !i.allowParallel ? ["allowParallel", "start", "skip"] : ["start", "skip"];
    default: return ["start", "skip"];
  }
}

/** 一行状态：状态加原因（有的话）。 */
export function intakeStateText(i: { state: IntakeItemView["state"]; waitReason: IntakeItemView["waitReason"] }, S: UiStrings): string {
  const s = S.ik.state[i.state] ?? i.state;
  return i.waitReason ? `${s} · ${S.ik.reason[i.waitReason] ?? i.waitReason}` : s;
}

/** 「现在」页的接活记录一行。 */
export function intakeRecentText(e: IntakeRecentEntry, S: UiStrings): string {
  const what = S.ik.recentWhat[e.what] ?? e.what;
  const detail = e.detail ? S.ik.reason[e.detail] ?? S.ik.option[e.detail] ?? e.detail : null;
  return detail ? `${e.key} · ${what} · ${detail}` : `${e.key} · ${what}`;
}

export function intakeActError(code: string, S: UiStrings): string {
  return S.ik.actError[code] ?? S.ik.actFailed(code);
}
