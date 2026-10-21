import type { EditableSettingKey } from "../../shared/settings";
import { SETTING_DEFAULTS, type SettingsRepo } from "../db/settings-repo";

export class SettingError extends Error {
  readonly code = "invalid_setting";
}

export interface ScheduleConfig {
  nightly: { h: number; m: number };
  workingDays: ReadonlySet<number>;
}

export interface Thresholds {
  blockedDays: number;
  reviewWaitDays: number;
  staleDays: number;
}

export function parseTime(v: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : null;
}

/** 不认识的项直接忽略。 */
export function parseWorkingDays(v: string): Set<number> {
  return new Set(v.split(/[\s,]+/).filter((t) => /^[0-6]$/.test(t)).map(Number));
}

/** 逗号、换行或括号外的空白分隔；`Bash(git status)` 括号里的空格保留。去重，保持顺序。 */
export function parseToolList(v: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  const flush = () => {
    const t = cur.trim();
    if (t && !out.includes(t)) out.push(t);
    cur = "";
  };
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) flush();
    else cur += ch;
  }
  flush();
  return out;
}

export function parseDays(v: string, fallback: number): number {
  const t = v.trim();
  return /^\d{1,3}$/.test(t) ? Number(t) : fallback;
}

/** 渲染进程提交的设置值：规范化后返回，不合法时抛 SettingError（界面显示 message）。 */
export function normalizeSetting(key: EditableSettingKey, value: string): string {
  switch (key) {
    case "nightlyTime": {
      const t = parseTime(value);
      if (!t) throw new SettingError("时间格式应为 HH:MM，例如 16:00");
      return `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
    }
    case "workingDays": {
      const tokens = value.split(/[\s,]+/).filter(Boolean);
      if (tokens.some((t) => !/^[0-6]$/.test(t))) throw new SettingError("工作日只能是 0–6（0 是周日）");
      return [...new Set(tokens.map(Number))].sort((a, b) => a - b).join(",");
    }
    case "trackerTools":
      return parseToolList(value).join("\n");
    case "blockedDays":
    case "reviewWaitDays":
    case "staleDays":
      if (!/^\d{1,3}$/.test(value.trim())) throw new SettingError("天数必须是 0–999 的整数");
      return String(Number(value.trim()));
    case "handoffPrompt":
    case "refreshPrompt":
      if (!value.trim()) throw new SettingError("prompt 模板不能为空");
      if (value.length > 20_000) throw new SettingError("prompt 模板太长（上限 20000 字）");
      return value;
  }
}

export function scheduleConfig(s: SettingsRepo): ScheduleConfig {
  // 工作日解析出空集合（损坏的值）会让晚间任务永远不跑，所以回退到默认。
  const days = parseWorkingDays(s.get("workingDays"));
  return {
    nightly: parseTime(s.get("nightlyTime")) ?? { h: 16, m: 0 },
    workingDays: days.size > 0 ? days : parseWorkingDays(SETTING_DEFAULTS.workingDays),
  };
}

export function thresholds(s: SettingsRepo): Thresholds {
  return {
    blockedDays: parseDays(s.get("blockedDays"), 2),
    reviewWaitDays: parseDays(s.get("reviewWaitDays"), 2),
    staleDays: parseDays(s.get("staleDays"), 5),
  };
}

export function trackerTools(s: SettingsRepo): string[] {
  return parseToolList(s.get("trackerTools"));
}
