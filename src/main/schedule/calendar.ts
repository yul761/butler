/** 本地时区的日期工具。日期一律用 "YYYY-MM-DD" 字符串表示，时刻用毫秒。 */
const pad = (n: number) => String(n).padStart(2, "0");

export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

/** 这一天本地 00:00。 */
export function dayStart(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(y, m - 1, d).getTime();
}

/** 这一天本地 h:m（夏令时切换当天也正确）。 */
export function atTime(date: string, h: number, min: number): number {
  const [y, m, d] = parts(date);
  return new Date(y, m - 1, d, h, min).getTime();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return localDate(new Date(y, m - 1, d + n).getTime());
}

/** 0 = 周日。 */
export function weekday(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(y, m - 1, d).getDay();
}

export function isWorkingDay(date: string, workingDays: ReadonlySet<number>): boolean {
  return workingDays.has(weekday(date));
}

/** 严格早于 date 的最近一个工作日（周一 → 上周五）；没有配置工作日时就是前一天。 */
export function previousWorkingDay(date: string, workingDays: ReadonlySet<number>): string {
  for (let i = 1; i <= 7; i++) {
    const c = addDays(date, -i);
    if (workingDays.has(weekday(c))) return c;
  }
  return addDays(date, -1);
}

/** 两个时刻之间相差的整天数，按本地日期算（夏令时切换不影响）。 */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((dayStart(localDate(toMs)) - dayStart(localDate(fromMs))) / 86_400_000);
}
