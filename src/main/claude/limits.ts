import type { LimitHit, LimitKind } from "../../shared/availability";

export const RESET_MAX_AHEAD_MS = 8 * 86_400_000;
export const RESET_PAST_SLACK_MS = 60_000;
const MESSAGE_MAX = 300;

/** 按顺序检查，先找到的种类胜出。 */
const PATTERNS: [LimitKind, RegExp][] = [
  ["model_unavailable", /issue with the selected model|may not exist or you may not have access|model_not_found/i],
  ["usage_limit", /usage limit reached|usage credit limit reached|spend limit reached|(?:5-hour|weekly|opus|session) limit reached|hit your limit|out of extra usage|credit balance (?:is )?too low|billing_error|usage limit is set to \$0/i],
  ["overloaded", /overloaded_error|\boverloaded\b/i],
  ["rate_limit", /rate_limit_error|rate.?limit|too many requests|ThrottlingException|too many tokens|quota/i],
];
/** not_found_error 要和 model 在同一行才算。 */
const NOT_FOUND_MODEL_RE = /not_found_error/i;
const API_ERROR_RE = /API Error:\s*(\d{3})\b/;

export function isPauseKind(k: LimitKind): boolean {
  return k === "usage_limit" || k === "rate_limit" || k === "overloaded";
}

const cut = (s: string): string => s.trim().slice(0, MESSAGE_MAX);

function firstLine(lines: string[], re: RegExp, also?: (l: string) => boolean): string | null {
  return lines.find((l) => re.test(l) || (also?.(l) ?? false)) ?? null;
}

function statusKind(status: number | null, text: string): LimitKind | null {
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status === 404 && /model/i.test(text)) return "model_unavailable";
  return null;
}

export function classifyLimit(i: { text: string; apiStatus: number | null; now: number; timeZone?: string }): LimitHit | null {
  const lines = i.text.split("\n");
  const hit = (kind: LimitKind, line: string | null): LimitHit => ({
    kind,
    resetsAt: resolveReset(i.text, i.now, i.timeZone),
    message: cut(line ?? i.text) || (i.apiStatus !== null ? `API status ${i.apiStatus}` : kind),
  });
  for (const [kind, re] of PATTERNS) {
    const isModel = kind === "model_unavailable";
    const line = firstLine(lines, re, isModel ? (l) => NOT_FOUND_MODEL_RE.test(l) && /model/i.test(l) : undefined);
    if (line !== null) return hit(kind, line);
  }
  const fromText = API_ERROR_RE.exec(i.text);
  for (const [status, scope] of [[i.apiStatus, null], [fromText ? Number(fromText[1]) : null, fromText ? firstLine(lines, API_ERROR_RE) : null]] as const) {
    const kind = statusKind(status, i.text);
    if (kind) return hit(kind, scope);
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const EPOCH_RE = /limit reached\|(\d{10}|\d{13})/i;
const RESETS_RE = /resets? (?:at )?(?:([A-Za-z]{3,9}) (\d{1,2}),? )?(?:(\d{1,2})(?::(\d{2}))?\s?(am|pm)?)?(?: \(([A-Za-z_]+\/[A-Za-z_]+|UTC)\))?/i;

function parts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const g: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") g[p.type] = Number(p.value);
  return { y: g.year, mo: g.month - 1, d: g.day, h: g.hour, mi: g.minute, s: g.second };
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

export function resolveReset(text: string, now: number, timeZone?: string): number | null {
  const inRange = (t: number): number | null => (t < now - RESET_PAST_SLACK_MS || t > now + RESET_MAX_AHEAD_MS ? null : t);
  const epoch = EPOCH_RE.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    return inRange(epoch[1].length === 10 ? n * 1000 : n);
  }
  const m = RESETS_RE.exec(text);
  if (!m) return null;
  const [, monName, dayStr, hourStr, minStr, ampm, stated] = m;
  const month = monName ? MONTHS.indexOf(monName.slice(0, 3).toLowerCase()) : -1;
  const hasDate = month >= 0 && !!dayStr;
  if (!hasDate && !hourStr) return null;
  try {
    const tz = stated ?? timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    let h = 0;
    let mi = 0;
    if (hourStr) {
      h = Number(hourStr);
      mi = minStr ? Number(minStr) : 0;
      const ap = ampm?.toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      else if (ap === "am" && h === 12) h = 0;
      if (h > 23 || mi > 59) return null;
    }
    const today = parts(now, tz);
    if (hasDate) {
      const day = Number(dayStr);
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
