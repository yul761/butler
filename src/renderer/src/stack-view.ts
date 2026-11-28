import {
  parseStackOverrides, STACK_MERGE_METHODS, STACK_OVERVIEWS, STACK_POLICY_DEFAULTS, StackPolicyError, stackIntRange,
  type StackLayerView, type StackNoticeInfo, type StackPolicyKey, type StackPolicyKeyView, type StackPolicyOverrides, type StackPolicyValue,
  type StackEpicNote, type StackPolicyView, type StackRunView, type StackView,
} from "../../shared/stacks";
import { resetClock } from "./availability-view";
import type { UiStrings } from "./strings";

/** 「现在」页一条栈提醒的字。 */
export function stackNoticeText(n: StackNoticeInfo, S: UiStrings): string {
  const t = S.sk.notice;
  switch (n.reason) {
    case "conflict": return t.conflict(n.stackName, n.branch, (n.files ?? []).join(", ") || "—");
    case "draft_stale": return t.draft_stale(n.stackName, n.branch, n.days ?? 0);
    case "behind": return t.behind(n.stackName, n.commits ?? 0, n.days ?? 0);
    case "stuck": return t.stuck(n.stackName, n.detail ?? "—");
    case "prs_unreadable": return t.prs_unreadable(n.stackName, n.host ?? null);
    case "markers": return t.markers(n.stackName, n.branch, (n.files ?? []).join(", "), n.where ?? "rewritten");
    case "held_below": return t.held_below(n.stackName, (n.branches ?? [n.branch]).join(", "), n.by ?? "—");
    case "no_push_remote": return t.no_push_remote(n.stackName, n.branch);
    case "ticket_closed": return t.ticket_closed(n.stackName, (n.branches ?? [n.branch]).join(", "));
    case "confirm":
      return t.confirm(n.stackName, (n.branches ?? [n.branch]).join(", "), n.detail === "handoff" || n.detail === "remote_ahead" ? n.detail : "ready_pr", n.push ?? true, n.toSession ?? true);
    case "rewritten": {
      const all = n.branches ?? [n.branch];
      const asked = n.asked ?? [];
      return t.rewritten(n.stackName, all.join(", "), asked.join(", "), all.filter((b) => !asked.includes(b)).join(", "));
    }
  }
}

/** 栈卡片上 autoRebase 的那句话（BTL-278：epic 档位定的要说出来）；开着、按策略开的不说。 */
export function stackAutoRebaseNote(s: StackView, S: UiStrings): string | null {
  if (s.autoRebaseBy === "explicit_off") return S.sk.autoRebaseExplicitOff;
  if (s.autoRebaseBy === "epic") return s.autoRebase ? S.sk.autoRebaseEpicOn : S.sk.autoRebaseEpicOff;
  return s.autoRebase ? null : S.sk.autoRebaseOff;
}

/** 设置页：这个范围里被 epic 档位打开的栈、epic 要开却被明确关掉的栈。 */
export function stackEpicLines(n: StackEpicNote | undefined, S: UiStrings): string[] {
  const out: string[] = [];
  if (n?.on.length) out.push(S.sk.epicOn(n.on.join(", ")));
  if (n?.ignored.length) out.push(S.sk.epicIgnored(n.ignored.join(", ")));
  return out;
}

/** 最近一次 rebase 的一行字（没有为 null），外加冲突和没推的分支。 */
export function lastRunLines(r: StackRunView | null, S: UiStrings, now: number): string[] {
  if (!r) return [];
  const lines = [S.sk.lastRun(S.sk.outcome[r.outcome], S.sk.trigger[r.trigger], resetClock(r.startedAt, now))];
  if (r.reason && (r.outcome === "deferred" || r.outcome === "failed")) lines[0] += ` · ${r.reason}`;
  if (r.conflict) lines.push(S.sk.conflict(r.conflict.branch, r.conflict.files.join(", ") || "—"));
  if (r.outcome === "needs_confirm" && r.confirm) lines.push(S.sk.confirmLine(r.confirm.why, r.confirm.branches.join(", "), r.confirm.push ?? true, r.confirm.toSession ?? true));
  if (r.unpushed.length > 0) lines.push(S.sk.unpushedList(r.unpushed.join(", ")));
  return lines;
}

/** 一层能按的按钮：栈底（第一个没合并的）不开 draft；分支能开成 draft，draft 能降回分支；合并了的不能动。 */
export function layerActions(s: StackView, l: StackLayerView): ("toDraft" | "toBranch")[] {
  if (l.state === "merged") return [];
  const bottom = s.layers.find((x) => x.state !== "merged");
  if (l.state === "draft") return ["toBranch"];
  if (bottom?.id === l.id || l.state === "ready") return [];
  return ["toDraft"];
}

export const isBottom = (s: StackView, l: StackLayerView): boolean => s.layers.find((x) => x.state !== "merged")?.id === l.id;

// ---- 设置页「栈」的策略编辑器 ----

export type StackDraft = Partial<Record<StackPolicyKey, string>>;

export type StackKeyKind = { kind: "bool" } | { kind: "enum"; options: readonly string[] } | { kind: "int"; min: number; max: number } | { kind: "text" };

export function stackKeyKind(key: StackPolicyKey): StackKeyKind {
  if (key === "mergeMethod") return { kind: "enum", options: STACK_MERGE_METHODS };
  if (key === "overview") return { kind: "enum", options: STACK_OVERVIEWS };
  const range = stackIntRange(key);
  if (range) return { kind: "int", min: range[0], max: range[1] };
  return typeof STACK_POLICY_DEFAULTS[key] === "boolean" ? { kind: "bool" } : { kind: "text" };
}

export const stackInputValue = (v: StackPolicyValue | null): string => (v === null ? "" : String(v));

/** 输入框里的字 → 值；"" = 继承。不合法时给出错误码。 */
export function parseStackInput(key: StackPolicyKey, raw: string): { ok: true; value: StackPolicyValue | null } | { ok: false; code: StackPolicyError["code"] } {
  const t = raw.trim();
  if (t === "") return { ok: true, value: null };
  const k = stackKeyKind(key);
  const v: unknown = k.kind === "int" ? Number(t) : k.kind === "bool" ? (t === "true" ? true : t === "false" ? false : t) : t;
  try {
    return { ok: true, value: parseStackOverrides({ [key]: v })[key] as StackPolicyValue };
  } catch (e) {
    if (e instanceof StackPolicyError) return { ok: false, code: e.code };
    throw e;
  }
}

/** 这一层原来的覆盖加上草稿，得出要保存的整层；有不合法的值时给出第一个坏键。 */
export function stackOverridesFromDraft(view: StackPolicyView, draft: StackDraft):
  { ok: true; overrides: StackPolicyOverrides; changed: boolean } | { ok: false; key: StackPolicyKey; code: StackPolicyError["code"] } {
  const out: Record<string, StackPolicyValue> = {};
  let changed = false;
  for (const k of view.keys) {
    const raw = draft[k.key];
    if (raw === undefined) {
      if (k.override !== null) out[k.key] = k.override;
      continue;
    }
    const r = parseStackInput(k.key, raw);
    if (!r.ok) return { ok: false, key: k.key, code: r.code };
    if (r.value !== k.override) changed = true;
    if (r.value !== null) out[k.key] = r.value;
  }
  return { ok: true, overrides: out as StackPolicyOverrides, changed };
}

/** 显示一个生效的值。 */
export function stackShown(k: Pick<StackPolicyKeyView, "key" | "effective">, S: UiStrings): string {
  const v = k.effective;
  if (typeof v === "boolean") return S.lp.bool(v);
  if (typeof v === "string") return S.sk.option[v] ?? v;
  return String(v);
}
