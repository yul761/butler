import type { LimitHit, LimitKind } from "../../shared/availability";
import type { LimitRule } from "../../shared/model-routing";

export const RESET_MAX_AHEAD_MS = 8 * 86_400_000;
export const RESET_PAST_SLACK_MS = 60_000;
const MESSAGE_MAX = 300;

/**
 * 内置识别规则（2.1.0 的 classifyLimit 原样搬成数据，顺序就是优先级）。id 固定，用户只能停用，不能改。
 * regex 规则按行匹配，第一行命中的作为 message；status 规则的 pattern 是 "429" 或 "404:model"（冒号后是整段文字要匹配的正则）。
 */
export const BUILTIN_RULES: readonly LimitRule[] = [
  rule("builtin:model_unavailable", "regex", "issue with the selected model|may not exist or you may not have access|model_not_found|^(?=.*not_found_error)(?=.*model)", "model_unavailable", false),
  rule("builtin:usage_limit", "regex", "usage limit reached|usage credit limit reached|spend limit reached|(?:5-hour|weekly|opus|session) limit reached|hit your (?:[\\w/-]+ )?limit|out of extra usage|credit balance (?:is )?too low|billing_error|usage limit is set to \\$0", "usage_limit", true),
  rule("builtin:overloaded", "regex", "overloaded_error|\\boverloaded\\b", "overloaded", false),
  rule("builtin:rate_limit", "regex", "rate_limit_error|rate.?limit|too many requests|ThrottlingException|too many tokens|quota", "rate_limit", false),
  rule("builtin:status_429", "status", "429", "rate_limit", false),
  rule("builtin:status_529", "status", "529", "overloaded", false),
  rule("builtin:status_404_model", "status", "404:model", "model_unavailable", false),
  rule("builtin:reset_epoch", "reset", "limit reached\\|(?<epoch>\\d{10}|\\d{13})", null, false),
  rule("builtin:reset_text", "reset", "(built-in \"resets …\" parser)", null, false),
];

function rule(id: string, kind: LimitRule["kind"], pattern: string, category: LimitKind | null, accountLevel: boolean): LimitRule {
  return { id, kind, pattern, category, accountLevel, source: "builtin", enabled: true, note: "" };
}

/** 编译好的一组规则。坏的用户正则跳过（记在 invalid 里），不让整个识别失效。 */
export interface RuleSet {
  text: Compiled[];
  status: Compiled[];
  reset: Compiled[];
  invalid: string[];
}
interface Compiled {
  rule: LimitRule;
  re: RegExp | null;
  status: number | null;
  /** status 规则的附加条件：整段文字要匹配。 */
  also: RegExp | null;
}

/** 字段规则 "error.type=rate_limit_error"：只看最后一段键名，键值在 JSON 里（引号可有可无）。 */
function fieldRegex(pattern: string): RegExp | null {
  const eq = pattern.indexOf("=");
  if (eq <= 0) return null;
  const key = pattern.slice(0, eq).split(".").pop()!.trim();
  const value = pattern.slice(eq + 1).trim();
  if (!key || !value) return null;
  return new RegExp(`"${escapeRe(key)}"\\s*:\\s*"?${escapeRe(value)}"?`, "i");
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 内置规则（按 overrides 停用）+ 用户 / 学到的规则。用户规则排在内置文字规则之后、状态码规则之前。 */
export function compileRules(extra: readonly LimitRule[], disabledBuiltins: ReadonlySet<string> = new Set()): RuleSet {
  const set: RuleSet = { text: [], status: [], reset: [], invalid: [] };
  const builtins = BUILTIN_RULES.filter((r) => !disabledBuiltins.has(r.id));
  const add = (r: LimitRule) => {
    try {
      if (r.kind === "regex") set.text.push({ rule: r, re: new RegExp(r.pattern, "i"), status: null, also: null });
      else if (r.kind === "field") {
        const re = fieldRegex(r.pattern);
        if (!re) throw new Error("bad field rule");
        set.text.push({ rule: r, re, status: null, also: null });
      } else if (r.kind === "status") {
        const m = /^(\d{3})(?::(.+))?$/.exec(r.pattern.trim());
        if (!m) throw new Error("bad status rule");
        set.status.push({ rule: r, re: null, status: Number(m[1]), also: m[2] ? new RegExp(m[2], "i") : null });
      } else if (r.kind === "reset") {
        set.reset.push({ rule: r, re: r.id === "builtin:reset_text" ? null : new RegExp(r.pattern, "i"), status: null, also: null });
      }
    } catch {
      set.invalid.push(r.id);
    }
  };
  for (const r of builtins) if (r.kind !== "status" && r.kind !== "reset") add(r);
  for (const r of extra) if (r.enabled && r.source !== "builtin" && (r.kind === "regex" || r.kind === "field")) add(r);
  for (const r of builtins) if (r.kind === "status") add(r);
  for (const r of extra) if (r.enabled && r.source !== "builtin" && r.kind === "status") add(r);
  for (const r of builtins) if (r.kind === "reset") add(r);
  for (const r of extra) if (r.enabled && r.source !== "builtin" && r.kind === "reset") add(r);
  return set;
}

export const DEFAULT_RULES: RuleSet = compileRules([]);

const API_ERROR_RE = /API Error:\s*(\d{3})\b/;
const cut = (s: string): string => s.trim().slice(0, MESSAGE_MAX);

export interface DetailedHit {
  hit: LimitHit;
  ruleId: string;
  accountLevel: boolean;
}

export interface ClassifyInput {
  text: string;
  apiStatus: number | null;
  now: number;
  timeZone?: string;
}

/** 按规则把一段报错归类；认不出返回 null。文字规则先于状态码（和 2.1.0 一样）。 */
export function classifyDetailed(set: RuleSet, i: ClassifyInput): DetailedHit | null {
  const lines = i.text.split("\n");
  const hit = (c: Compiled, line: string | null): DetailedHit => ({
    hit: {
      kind: c.rule.category!,
      resetsAt: resolveResetWith(set, i.text, i.now, i.timeZone),
      message: cut(line ?? i.text) || (i.apiStatus !== null ? `API status ${i.apiStatus}` : c.rule.category!),
    },
    ruleId: c.rule.id,
    accountLevel: c.rule.accountLevel,
  });
  for (const c of set.text) {
    if (c.rule.kind === "field") {
      if (c.re!.test(i.text)) {
        const value = c.rule.pattern.slice(c.rule.pattern.indexOf("=") + 1).trim().toLowerCase();
        return hit(c, lines.find((l) => l.toLowerCase().includes(value)) ?? null);
      }
      continue;
    }
    const line = lines.find((l) => c.re!.test(l));
    if (line !== undefined) return hit(c, line);
  }
  const fromText = API_ERROR_RE.exec(i.text);
  const sources: [number | null, string | null][] = [
    [i.apiStatus, null],
    [fromText ? Number(fromText[1]) : null, fromText ? (lines.find((l) => API_ERROR_RE.test(l)) ?? null) : null],
  ];
  for (const [status, line] of sources) {
    if (status === null) continue;
    const c = set.status.find((s) => s.status === status && (s.also === null || s.also.test(i.text)));
    if (c) return hit(c, line);
  }
  return null;
}

// ---- 通用信号 ----

export type GenericSignal = { kind: LimitKind; signal: "status" | "keyword" };
const GENERIC_STATUS: Record<number, LimitKind> = { 429: "rate_limit", 529: "overloaded", 402: "usage_limit" };
const MONEY_WORDS = /\b(?:quota|billing|credits?|insufficient[_ ]funds|payment required)\b/i;
const LIMIT_WORD = /\blimit(?:s|ed)?\b/i;
/** 说的是这次对话本身到了上限（上下文、轮数、输出长度、文件大小），不是模型或账号被限：换模型也一样，不算信号。 */
const NOT_A_SERVICE_LIMIT = /\b(?:context(?:[ _-]window)?|prompt|max[ _-]?turns?|turns?|tokens?|output|length|size|file|line|recursion|depth|timeout|time)[ _-]+limit|\blimit[ _-]+(?:of|on)[ _-]+(?:turns?|tokens?|context)|context[ _-]length|max_tokens|too long/i;

/**
 * 规则认不出、但运行失败时看的通用信号：HTTP 429 / 529 / 402，输出里有 quota / billing / credit（→ 额度）或 limit（→ 限流；
 * 上下文、轮数、token、输出长度这类「这次对话到了上限」的不算）。
 * 只在 run 失败（非零退出或 is_error）时调用。
 */
export function genericSignal(i: { text: string; apiStatus: number | null }): GenericSignal | null {
  const fromText = API_ERROR_RE.exec(i.text);
  for (const s of [i.apiStatus, fromText ? Number(fromText[1]) : null]) {
    if (s !== null && GENERIC_STATUS[s]) return { kind: GENERIC_STATUS[s]!, signal: "status" };
  }
  if (MONEY_WORDS.test(i.text)) return { kind: "usage_limit", signal: "keyword" };
  if (LIMIT_WORD.test(i.text) && !NOT_A_SERVICE_LIMIT.test(i.text)) return { kind: "rate_limit", signal: "keyword" };
  return null;
}

/** 报错里点名的模型（Claude Code 的 "model sent to the API: X"，或 404 的 "model: X"），没有为 null。 */
export function namedModel(text: string): string | null {
  const m = /model sent to the API:\s*([A-Za-z0-9][\w.:/@[\]-]*)/i.exec(text) ?? /selected model \(([^)\s]+)\)/i.exec(text) ?? /"message"\s*:\s*"model:\s*([^"\s]+)"/i.exec(text);
  return m ? m[1]!.replace(/[.,)]+$/, "") : null;
}

// ---- 重置时间 ----

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RESETS_RE = /resets? (?:at )?(?:([A-Za-z]{3,9}) (\d{1,2}),?(?: at)? )?(?:(\d{1,2})(?::(\d{2}))?\s?(am|pm)?)?(?: \(([A-Za-z_]+\/[A-Za-z_]+|UTC)\))?/i;

function parts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const g: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") g[p.type] = Number(p.value);
  return { y: g.year!, mo: g.month! - 1, d: g.day!, h: g.hour!, mi: g.minute!, s: g.second! };
}

function offsetMs(tz: string, ms: number): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** 某时区的墙上时间 → UTC 毫秒。迭代两次处理夏令时边界。 */
function wallToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo, d, h, mi);
  let guess = wall - offsetMs(tz, wall);
  guess = wall - offsetMs(tz, guess);
  return guess;
}

interface WallParts { monName?: string; day?: string; hour?: string; minute?: string; ampm?: string; tz?: string }

/** 墙上时间（可带日期、时区）→ 下一次出现的时刻。 */
function fromWall(p: WallParts, now: number, timeZone: string | undefined, inRange: (t: number) => number | null): number | null {
  const month = p.monName ? MONTHS.indexOf(p.monName.slice(0, 3).toLowerCase()) : -1;
  const hasDate = month >= 0 && !!p.day;
  if (!hasDate && !p.hour) return null;
  try {
    const tz = p.tz ?? timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    let h = 0;
    let mi = 0;
    if (p.hour) {
      h = Number(p.hour);
      mi = p.minute ? Number(p.minute) : 0;
      const ap = p.ampm?.toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      else if (ap === "am" && h === 12) h = 0;
      if (h > 23 || mi > 59) return null;
    }
    const today = parts(now, tz);
    if (hasDate) {
      const day = Number(p.day);
      let t = wallToUtc(tz, today.y, month, day, h, mi);
      if (t < now - RESET_PAST_SLACK_MS) t = wallToUtc(tz, today.y + 1, month, day, h, mi);
      return inRange(t);
    }
    let t = wallToUtc(tz, today.y, today.mo, today.d, h, mi);
    if (t < now - RESET_PAST_SLACK_MS) t = wallToUtc(tz, today.y, today.mo, today.d + 1, h, mi);
    return inRange(t);
  } catch {
    // 不认识的时区名。
    return null;
  }
}

/** 一条重置规则的结果：undefined 是没匹配上（试下一条），null 是匹配上了但时间不能用。 */
function applyReset(c: Compiled, text: string, now: number, timeZone: string | undefined, inRange: (t: number) => number | null): number | null | undefined {
  if (c.rule.id === "builtin:reset_text") {
    const m = RESETS_RE.exec(text);
    if (!m) return undefined;
    const [, monName, day, hour, minute, ampm, tz] = m;
    if (!(monName && day) && !hour) return undefined;
    return fromWall({ monName, day, hour, minute, ampm, tz }, now, timeZone, inRange);
  }
  const m = c.re!.exec(text);
  if (!m) return undefined;
  const g = m.groups ?? {};
  if (g.epoch) {
    const n = Number(g.epoch);
    return inRange(g.epoch.length >= 13 ? n : n * 1000);
  }
  if (g.iso) {
    const t = Date.parse(g.iso);
    return Number.isNaN(t) ? null : inRange(t);
  }
  const rel = (g.in_s ? Number(g.in_s) * 1000 : 0) + (g.in_m ? Number(g.in_m) * 60_000 : 0) + (g.in_h ? Number(g.in_h) * 3_600_000 : 0);
  if (rel > 0) return inRange(now + rel);
  if (g.hour || g.day) return fromWall({ monName: g.month, day: g.day, hour: g.hour, minute: g.minute, ampm: g.ampm, tz: g.tz }, now, timeZone, inRange);
  return undefined;
}

/** 按顺序试重置规则，第一条匹配上的说了算（和 2.1.0 一样：epoch 形式匹配上但超出范围就是 null）。 */
export function resolveResetWith(set: RuleSet, text: string, now: number, timeZone?: string): number | null {
  const inRange = (t: number): number | null => (t < now - RESET_PAST_SLACK_MS || t > now + RESET_MAX_AHEAD_MS ? null : t);
  for (const c of set.reset) {
    const r = applyReset(c, text, now, timeZone, inRange);
    if (r !== undefined) return r;
  }
  return null;
}

// ---- 当前生效的规则 ----

let active: RuleSet = DEFAULT_RULES;
/** 设置当前生效的规则（启动时和规则变了时由路由服务调用）。 */
export function setActiveRules(set: RuleSet): void {
  active = set;
}
export function activeRules(): RuleSet {
  return active;
}
