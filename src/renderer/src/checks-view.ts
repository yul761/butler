// 检查页（工作流 E1）的纯函数：表单 ↔ CheckInput、层的键、统计和错误文字。组件只管界面状态。
import type { CheckInput, CheckMode, CheckScope, CheckSeverity, CheckStage, CheckStats, CheckType, ChecksActResult, ChecksView, CheckDraftResult } from "../../shared/checks";
import type { UiStrings } from "./strings";

/** 表单里的样子：列表是一行一个的文字，时间是秒。 */
export interface CheckForm {
  type: CheckType;
  name: string;
  message: string;
  pattern: string;
  literal: boolean;
  ignoreCase: boolean;
  forbid: string;
  allow: string;
  keywords: string;
  ticketPattern: string;
  command: string;
  stage: CheckStage;
  timeoutSec: string;
  globs: string;
  excludeGlobs: string;
  severity: CheckSeverity;
  mode: CheckMode;
  enabled: boolean;
}

/** 新建的检查：拦截、试运行、打开。 */
export const emptyForm = (type: CheckType = "forbidden_pattern"): CheckForm => ({
  type, name: "", message: "", pattern: "", literal: false, ignoreCase: false, forbid: "", allow: "", keywords: "", ticketPattern: "",
  command: "", stage: "edit", timeoutSec: "", globs: "", excludeGlobs: "", severity: "block", mode: "shadow", enabled: true,
});

/** 一行一个，去掉空行和两头空白（Windows 的换行也认）。 */
export const splitLines = (s: string): string[] => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const joinLines = (v: unknown): string => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join("\n") : "");
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function formFromInput(i: CheckInput): CheckForm {
  const p = i.params;
  const ms = typeof p.timeoutMs === "number" ? p.timeoutMs : null;
  return {
    ...emptyForm(i.type),
    name: i.name, message: i.message, globs: i.globs.join("\n"), excludeGlobs: i.excludeGlobs.join("\n"), severity: i.severity, mode: i.mode, enabled: i.enabled,
    pattern: str(p.pattern), literal: p.literal === true, ignoreCase: p.flags === "i",
    forbid: joinLines(p.forbid), allow: joinLines(p.allow),
    keywords: joinLines(p.keywords), ticketPattern: str(p.ticketPattern),
    command: str(p.command), stage: p.stage === "push" ? "push" : "edit", timeoutSec: ms === null ? "" : String(ms / 1000),
  };
}

/** 只带这种类型的参数；校验在主进程（validateCheckInput），这里不重复。 */
export function inputFromForm(f: CheckForm): CheckInput {
  let params: Record<string, unknown>;
  switch (f.type) {
    case "forbidden_pattern":
      params = { pattern: f.pattern, ...(f.ignoreCase ? { flags: "i" } : {}), ...(f.literal ? { literal: true } : {}) };
      break;
    case "import_boundary":
      params = { forbid: splitLines(f.forbid), allow: splitLines(f.allow) };
      break;
    case "comment_policy":
      params = { keywords: splitLines(f.keywords), ticketPattern: f.ticketPattern.trim() };
      break;
    case "run_command": {
      const t = f.timeoutSec.trim();
      // 写的不是数字也照样送过去：主进程会说「时间不对」，比悄悄丢掉好。
      params = { command: f.command, stage: f.stage, ...(t ? { timeoutMs: /^\d+(\.\d+)?$/.test(t) ? Math.round(Number(t) * 1000) : -1 } : {}) };
      break;
    }
  }
  return {
    type: f.type, name: f.name.trim(), params, globs: splitLines(f.globs), excludeGlobs: splitLines(f.excludeGlobs), severity: f.severity, mode: f.mode, enabled: f.enabled,
    message: f.message.trim(),
  };
}

/** 下拉框里的值。 */
export const scopeKey = (s: CheckScope): string => (s.kind === "global" ? "global" : s.kind === "product" ? `product:${s.productId}` : `repo:${s.slug}`);

export function parseScopeKey(k: string): CheckScope {
  if (k.startsWith("product:")) {
    const id = Number(k.slice(8));
    if (Number.isSafeInteger(id) && id > 0) return { kind: "product", productId: id };
  }
  if (k.startsWith("repo:") && k.length > 5) return { kind: "repo", slug: k.slice(5) };
  return { kind: "global" };
}

/** 页面上能选的层；选中的层不在了（产品删了）就回到全局。 */
export function scopeOptions(v: Pick<ChecksView, "products" | "repos">, S: UiStrings): { key: string; label: string }[] {
  return [
    { key: "global", label: S.checksLayerGlobal },
    ...v.products.map((p) => ({ key: `product:${p.id}`, label: S.checksLayerProduct(p.name) })),
    ...v.repos.map((slug) => ({ key: `repo:${slug}`, label: S.checksLayerRepo(slug) })),
  ];
}

/** 采纳率：命中之后被 agent 改掉的比例；还没有命中就不显示。 */
export const adoption = (s: Pick<CheckStats, "fails" | "resolved">): string | null => (s.fails > 0 ? `${Math.round((Math.min(s.resolved, s.fails) / s.fails) * 100)}%` : null);

/** 一行里简单说明这条检查查什么。 */
export function paramsSummary(type: CheckType, p: Record<string, unknown>, S: UiStrings): string {
  switch (type) {
    case "forbidden_pattern":
      return `${p.literal === true ? JSON.stringify(str(p.pattern)) : `/${str(p.pattern)}/${p.flags === "i" ? "i" : ""}`}`;
    case "import_boundary":
      return `✗ ${joinLines(p.forbid).split("\n").join(", ")}${Array.isArray(p.allow) && p.allow.length ? ` · ✓ ${joinLines(p.allow).split("\n").join(", ")}` : ""}`;
    case "comment_policy":
      return Array.isArray(p.keywords) && p.keywords.length ? joinLines(p.keywords).split("\n").join(", ") : S.checksDefaultKeywords;
    case "run_command":
      return `${str(p.command)} · ${S.checksStageLabel[p.stage === "push" ? "push" : "edit"]}`;
  }
}

/** 操作失败的文字：内容不对的按字段说。 */
export function checksErrorText(r: Extract<ChecksActResult, { ok: false }>, S: UiStrings): string {
  if (r.reason === "invalid" && r.message && S.checksInvalid[r.message]) return S.checksInvalid[r.message];
  return S.checksError[r.reason] ?? S.checksErrorGeneric;
}

/** 起草失败的文字。 */
export function draftErrorText(r: Extract<CheckDraftResult, { ok: false }>, S: UiStrings): string {
  if (r.reason === "claude_missing") return S.lessonDraftNoClaude;
  if (r.reason === "not_found") return S.checksError.not_found;
  return S.lessonDraftFailed(r.message || r.reason);
}

/** 勾选里只留这一层自己的、还在的行（继承来的改不了，要先覆盖）。 */
export function livePickedChecks(picked: number[], v: Pick<ChecksView, "checks">): number[] {
  const own = new Set(v.checks.flatMap((c) => (c.own ? [c.own.id] : [])));
  return picked.filter((id) => own.has(id));
}
