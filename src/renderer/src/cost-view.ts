import type { BgKind, BgKindOverride } from "../../shared/background";
import { parseCostOverrides, type CostBreakerView, type CostPolicyOverrides, type CostPolicyValue, type CostPolicyView, type CostUnit } from "../../shared/cost";
import type { UiStrings } from "./strings";

const trim = (n: number, digits: number): string => n.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

/** 花了多少：美元按大小留两位 / 一位 / 不留小数；token 写成 k / M。 */
export function costAmount(n: number, unit: CostUnit, S: UiStrings): string {
  if (unit === "usd") return `$${n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)}`;
  const t = n >= 1e6 ? `${trim(n / 1e6, 1)}M` : n >= 1e3 ? `${trim(n / 1e3, 1)}k` : String(Math.round(n));
  return S.cs.tokens(t);
}

/** 一条熔断状态的一句话（「现在」页提醒、session 行、设置页共用）。 */
export function costBreakerText(b: CostBreakerView, S: UiStrings): string {
  const subj = S.cs.subject(b.subjectKind, b.title);
  const spent = costAmount(b.spent, b.unit, S);
  const cap = costAmount(b.cap, b.unit, S);
  const head =
    b.state === "warned" ? S.cs.warned(subj, spent, cap)
    : b.state === "downgraded" ? (b.fromModel !== null && b.toModel !== null ? S.cs.downgraded(subj, spent, cap, b.fromModel, b.toModel) : S.cs.downgradedHeadless(subj, spent, cap))
    : b.pauseScope === "background" ? S.cs.pausedBackground(subj, spent, cap) : S.cs.paused(subj, spent, cap);
  const parts = [head];
  if (b.stoppedAt !== null) parts.push(S.cs.stopped);
  if (b.takenOver) parts.push(S.cs.takenOver);
  if (b.partial) parts.push(S.cs.partial);
  return parts.join(" · ");
}

/** 编辑器草稿：键 → 输入框里的字；"" = 继承。没出现的键 = 没改。 */
export type CostDraft = Record<string, string>;

const CAP_KEYS = new Set(["sessionCap", "ticketCap"]);
const NUMBER_KEYS = new Set(["sessionCap", "ticketCap", "graceAfterDowngradePercent", "raisePercent"]);
const NONE_WORDS = new Set(["none", "不限", "unlimited"]);

/** 一个值写进输入框：没设写 ""，设成不限写 none。 */
export const costInputValue = (key: string, set: boolean, v: CostPolicyValue): string => (!set ? "" : v === null ? (CAP_KEYS.has(key) ? "none" : "") : String(v));

/** 输入框里的字 → 值。{inherit} = 这一层不设；不合法返回 undefined。 */
export function parseCostInput(key: string, raw: string): { inherit: true } | { value: CostPolicyValue } | undefined {
  const t = raw.trim();
  if (t === "") return { inherit: true };
  let v: unknown = t;
  if (CAP_KEYS.has(key) && NONE_WORDS.has(t.toLowerCase())) v = null;
  else if (NUMBER_KEYS.has(key)) v = Number(t);
  try {
    const o = parseCostOverrides({ [key]: v }) as Record<string, CostPolicyValue>;
    return { value: o[key] ?? null };
  } catch {
    return undefined;
  }
}

/** 这一层现在的覆盖 + 草稿 → 要保存的整层。 */
export function costOverridesFromDraft(view: CostPolicyView, draft: CostDraft): { ok: true; overrides: CostPolicyOverrides; changed: boolean } | { ok: false; badKey: string } {
  const out: Record<string, CostPolicyValue> = {};
  let changed = false;
  for (const k of view.keys) {
    const raw = draft[k.key];
    if (raw === undefined) {
      if (k.set) out[k.key] = k.override;
      continue;
    }
    const p = parseCostInput(k.key, raw);
    if (p === undefined) return { ok: false, badKey: k.key };
    if ("inherit" in p) {
      if (k.set) changed = true;
      continue;
    }
    if (!k.set || p.value !== k.override) changed = true;
    out[k.key] = p.value;
  }
  return { ok: true, overrides: out as CostPolicyOverrides, changed };
}

/** 改一种后台任务的覆盖（设置 bgKinds 的 JSON）：值为 undefined 的键删掉，空了的种类整个删掉。 */
export function withKindOverride(json: string, kind: BgKind, patch: Partial<Record<keyof BgKindOverride, BgKindOverride[keyof BgKindOverride] | undefined>>): string {
  let all: Record<string, Record<string, unknown>> = {};
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) all = v as Record<string, Record<string, unknown>>;
  } catch {
    // 坏了的当作没设
  }
  const cur: Record<string, unknown> = { ...(all[kind] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete cur[k];
    else cur[k] = v;
  }
  const next = { ...all };
  if (Object.keys(cur).length > 0) next[kind] = cur;
  else delete next[kind];
  return Object.keys(next).length > 0 ? JSON.stringify(next) : "";
}

/** 这一行该显示哪条：先看 session 自己的，再看它的 ticket 的（ticket 只是快到上限时不在每一行上提醒）。 */
export function breakerFor(all: CostBreakerView[], sessionId: string, ticketKey: string | null): CostBreakerView | null {
  return (
    all.find((b) => b.subjectKind === "session" && b.sessionId === sessionId)
    ?? (ticketKey === null ? undefined : all.find((b) => b.subjectKind === "ticket" && b.subjectId === ticketKey && b.state !== "warned"))
    ?? null
  );
}
