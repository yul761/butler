import type { KeyCount } from "../../shared/metrics";
import { S } from "./strings";

/** 「效果」页可选的时间范围（天）。 */
export const DAY_CHOICES = [7, 30, 90, 365] as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 不知道的值写成 —。 */
export const DASH = "—";

/** 一位小数，整数不带 .0：2 → "2"，2.34 → "2.3"。 */
export function fmtNumber(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  const s = v.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** 平均时长：不到 1 小时按分钟，不到 2 天按小时，再长按天（一位小数）。 */
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return DASH;
  const v = Math.max(0, ms);
  if (v === 0) return S.durationMinutes(0);
  if (v < 60_000) return S.effect.durUnderMinute;
  if (v < HOUR) return S.durationMinutes(Math.round(v / 60_000));
  if (v < 2 * DAY) return S.effect.durHours(fmtNumber(v / HOUR));
  return S.effect.durDays(fmtNumber(v / DAY));
}

/** token 数：12_345_678 → "12.3M"，45_600 → "45.6K"，不到 1000 取整。 */
export function fmtTokens(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return DASH;
  if (v >= 1e9) return `${fmtNumber(v / 1e9)}B`;
  if (v >= 1e6) return `${fmtNumber(v / 1e6)}M`;
  if (v >= 1e3) return `${fmtNumber(v / 1e3)}K`;
  return String(Math.round(v));
}

/** 美元：小于 1 两位小数，否则一位。 */
export function fmtUsd(v: number): string {
  return v < 1 ? v.toFixed(2) : fmtNumber(v);
}

/** 本地日期 "YYYY-MM-DD" 的短写法（月/日）。 */
export function fmtDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: "numeric", day: "numeric" });
}

export type Comparison = { kind: "none" } | { kind: "same" } | { kind: "delta"; pct: string; better: boolean };

/** 和基线比（四张卡都是越少越好）。没有基线、基线是 0 或者没有值时 none。 */
export function compare(value: number | null, base: number | null | undefined): Comparison {
  if (value === null || base === null || base === undefined || base <= 0) return { kind: "none" };
  const ratio = (value - base) / base;
  const pct = Math.round(Math.abs(ratio) * 100);
  if (pct === 0) return { kind: "same" };
  return { kind: "delta", pct: `${pct}%`, better: ratio < 0 };
}

/** 比较那一行的文字。 */
export function comparisonText(c: Comparison): string | null {
  if (c.kind === "none") return null;
  return c.kind === "same" ? S.effect.sameAsBaseline : S.effect.vsBaseline(c.pct, c.better);
}

/** 人介入的名字：kind 或 kind:子类。不认识的原样显示。 */
export function interventionName(key: string): string {
  const names = S.effect.interventionNames;
  const i = key.indexOf(":");
  if (i < 0) return names[key] ?? key;
  const kind = key.slice(0, i);
  const sub = key.slice(i + 1);
  return `${names[kind] ?? kind} · ${names[sub] ?? sub}`;
}

/** 花费的 key：没有任务的是交互 session，没写模型的是默认模型。 */
export function spendName(key: string): string {
  if (key === "(interactive)") return S.effect.interactive;
  if (key === "(default)") return S.effect.defaultModel;
  return key;
}

/** 分组的 key：风险等级没有值的是「未分级」。 */
export function groupName(key: string): string {
  return key === "unrated" ? S.effect.unrated : key;
}

/** 横条宽度：相对最大值的百分比；最大值是 0 时都是 0。 */
export function barWidths(values: readonly number[]): number[] {
  const max = Math.max(0, ...values);
  return values.map((v) => (max > 0 ? (Math.max(0, v) / max) * 100 : 0));
}

/** 人介入里，子类（kind:sub）挂在它的 kind 下面；只有子类、没有 kind 那一行的也单独成行。 */
export function interventionRows(items: readonly KeyCount[]): { key: string; n: number; subs: KeyCount[] }[] {
  const top = items.filter((x) => !x.key.includes(":"));
  const subs = items.filter((x) => x.key.includes(":"));
  const rows = top.map((t) => ({ key: t.key, n: t.n, subs: subs.filter((s) => s.key.startsWith(`${t.key}:`)) }));
  for (const s of subs) if (!top.some((t) => s.key.startsWith(`${t.key}:`))) rows.push({ key: s.key, n: s.n, subs: [] });
  return rows;
}

export interface LineGeometry {
  /** SVG path（遇到空值断开）。 */
  path: string;
  points: { i: number; x: number; y: number }[];
  max: number;
}

/** 折线：x 均分，y 从 0 到最大值（留 10% 余量）。空值不画点、断开线。 */
export function lineGeometry(values: readonly (number | null)[], width: number, height: number, pad: number): LineGeometry {
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const max = real.length === 0 ? 0 : Math.max(...real);
  const top = max > 0 ? max * 1.1 : 1;
  const step = values.length > 1 ? (width - 2 * pad) / (values.length - 1) : 0;
  const points: LineGeometry["points"] = [];
  let path = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    const x = pad + i * step;
    const y = height - pad - (v / top) * (height - 2 * pad);
    path += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
    points.push({ i, x, y });
  });
  return { path, points, max };
}
