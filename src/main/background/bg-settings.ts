import {
  BG_PRIORITIES, BG_QUOTA_ORDERS, BG_WINDOWS, BG_YIELDS, isBgKind,
  type BgKind, type BgKindOverride, type BgQuotaOrder, type BgWindow, type BgYield,
} from "../../shared/background";
import { M } from "../strings";

export class BgSettingError extends Error {}

export type BgSettingKey = "bgWindow" | "bgHours" | "bgIdleMinutes" | "bgYield" | "bgQuotaOrder" | "bgPlentifulPercent" | "bgKinds";

export const BG_SETTING_KEYS: readonly BgSettingKey[] = ["bgWindow", "bgHours", "bgIdleMinutes", "bgYield", "bgQuotaOrder", "bgPlentifulPercent", "bgKinds"];

export const DEFAULT_BG_HOURS = "22:00-07:00";
export const DEFAULT_BG_IDLE_MINUTES = 10;
export const MAX_BG_IDLE_MINUTES = 240;

/** 一段时间，按一天里的分钟数；to <= from 表示跨午夜。 */
export interface HoursRange { from: number; to: number }

export interface BgSettings {
  window: BgWindow;
  hours: HoursRange[];
  /** 原样（规范化后）的小时文字，界面显示用。 */
  hoursText: string;
  idleMinutes: number;
  yieldMode: BgYield;
  quotaOrder: BgQuotaOrder;
  /** 每个配额都用了不到这个百分比就算额度充裕；null = 不用。 */
  plentifulPercent: number | null;
  kinds: Partial<Record<BgKind, BgKindOverride>>;
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function minutesOf(t: string): number | null {
  const m = TIME_RE.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const fmt = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** 「22:00-07:00, 12:00-13:00」→ 区间；空串是没有；格式不对返回 null。 */
export function parseHours(text: string): HoursRange[] | null {
  const t = text.trim();
  if (!t) return [];
  const out: HoursRange[] = [];
  for (const part of t.split(",")) {
    const [a, b, extra] = part.split("-");
    if (a === undefined || b === undefined || extra !== undefined) return null;
    const from = minutesOf(a);
    const to = minutesOf(b);
    if (from === null || to === null || from === to) return null;
    out.push({ from, to });
  }
  return out;
}

const minuteOfDay = (now: number) => {
  const d = new Date(now);
  return d.getHours() * 60 + d.getMinutes();
};

/** now（本地时间）在不在这些区间里；区间含起点、不含终点。 */
export function inHours(ranges: readonly HoursRange[], now: number): boolean {
  const m = minuteOfDay(now);
  return ranges.some((r) => (r.from < r.to ? m >= r.from && m < r.to : m >= r.from || m < r.to));
}

/** 下一个区间开始的时间（本地时间，毫秒）；没有区间为 null。 */
export function nextHoursStart(ranges: readonly HoursRange[], now: number): number | null {
  if (ranges.length === 0) return null;
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let best: number | null = null;
  for (const day of [0, 1]) {
    for (const r of ranges) {
      const base = new Date(midnight);
      base.setDate(base.getDate() + day);
      const t = base.getTime() + r.from * 60_000;
      if (t > now && (best === null || t < best)) best = t;
    }
  }
  return best;
}

/** 下一个区间结束的时间（now 在区间里时用）；不在区间里为 null。 */
export function hoursEnd(ranges: readonly HoursRange[], now: number): number | null {
  if (!inHours(ranges, now)) return null;
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let best: number | null = null;
  for (const day of [0, 1]) {
    for (const r of ranges) {
      const base = new Date(midnight);
      base.setDate(base.getDate() + day);
      const t = base.getTime() + r.to * 60_000;
      if (t > now && (best === null || t < best)) best = t;
    }
  }
  return best;
}

function parseOverride(v: unknown): BgKindOverride | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: BgKindOverride = {};
  if ((BG_PRIORITIES as readonly unknown[]).includes(o.priority)) out.priority = o.priority as BgKindOverride["priority"];
  if ((BG_WINDOWS as readonly unknown[]).includes(o.window)) out.window = o.window as BgWindow;
  if (o.paused === true) out.paused = true;
  return out;
}

/** 设置 bgKinds：认不出的种类和字段丢掉。 */
export function parseKinds(text: string): Partial<Record<BgKind, BgKindOverride>> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const out: Partial<Record<BgKind, BgKindOverride>> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isBgKind(k)) continue;
    const o = parseOverride(raw);
    if (o && Object.keys(o).length > 0) out[k] = o;
  }
  return out;
}

const pick = <T extends string>(list: readonly T[], v: string, fallback: T): T => ((list as readonly string[]).includes(v.trim()) ? (v.trim() as T) : fallback);

function intIn(v: string, min: number, max: number): number | null {
  const t = v.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** 读后台调度的设置；存坏了的值回到默认（默认 = 2.1.0 的行为：随时跑）。 */
export function readBgSettings(s: { get(key: string): string }): BgSettings {
  const hoursText = s.get("bgHours").trim() || DEFAULT_BG_HOURS;
  const hours = parseHours(hoursText) ?? parseHours(DEFAULT_BG_HOURS)!;
  return {
    window: pick(BG_WINDOWS, s.get("bgWindow"), "anytime"),
    hours,
    hoursText: hours.map((r) => `${fmt(r.from)}-${fmt(r.to)}`).join(", "),
    idleMinutes: intIn(s.get("bgIdleMinutes"), 1, MAX_BG_IDLE_MINUTES) ?? DEFAULT_BG_IDLE_MINUTES,
    yieldMode: pick(BG_YIELDS, s.get("bgYield"), "finish"),
    quotaOrder: pick(BG_QUOTA_ORDERS, s.get("bgQuotaOrder"), "pause_first"),
    plentifulPercent: intIn(s.get("bgPlentifulPercent"), 1, 99),
    kinds: s.get("bgKinds").trim() ? parseKinds(s.get("bgKinds")) : {},
  };
}

/** 设置页存之前的检查和规范化：不合法就整个拒绝。 */
export function normalizeBgSetting(key: BgSettingKey, value: string): string {
  const s = M().background;
  const t = value.trim();
  switch (key) {
    case "bgWindow":
      if (!(BG_WINDOWS as readonly string[]).includes(t)) throw new BgSettingError(s.badWindow);
      return t;
    case "bgYield":
      if (!(BG_YIELDS as readonly string[]).includes(t)) throw new BgSettingError(s.badYield);
      return t;
    case "bgQuotaOrder":
      if (!(BG_QUOTA_ORDERS as readonly string[]).includes(t)) throw new BgSettingError(s.badQuotaOrder);
      return t;
    case "bgHours": {
      const r = parseHours(t);
      if (r === null || r.length === 0) throw new BgSettingError(s.badHours);
      return r.map((x) => `${fmt(x.from)}-${fmt(x.to)}`).join(", ");
    }
    case "bgIdleMinutes": {
      const n = intIn(t, 1, MAX_BG_IDLE_MINUTES);
      if (n === null) throw new BgSettingError(s.badIdleMinutes(MAX_BG_IDLE_MINUTES));
      return String(n);
    }
    case "bgPlentifulPercent": {
      if (!t) return "";
      const n = intIn(t, 1, 99);
      if (n === null) throw new BgSettingError(s.badPlentiful);
      return String(n);
    }
    case "bgKinds": {
      if (!t) return "";
      let v: unknown;
      try {
        v = JSON.parse(t);
      } catch {
        throw new BgSettingError(s.badKinds);
      }
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new BgSettingError(s.badKinds);
      const out: Partial<Record<BgKind, BgKindOverride>> = {};
      for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
        if (!isBgKind(k) || typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new BgSettingError(s.badKinds);
        const o = parseOverride(raw)!;
        const fields = Object.keys(raw as object);
        if (fields.some((f) => !(f in o) && !(f === "paused" && (raw as { paused?: unknown }).paused === false))) throw new BgSettingError(s.badKinds);
        if (Object.keys(o).length > 0) out[k] = o;
      }
      return Object.keys(out).length === 0 ? "" : JSON.stringify(out);
    }
  }
}
