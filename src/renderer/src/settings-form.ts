/** 设置页里星期的显示顺序（周一在前）；数字是 JS getDay()，0 是周日。 */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const parseDays = (value: string): number[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);

export function hasDay(value: string, day: number): boolean {
  return parseDays(value).includes(day);
}

export function toggleDay(value: string, day: number): string {
  const days = new Set(parseDays(value));
  if (days.has(day)) days.delete(day);
  else days.add(day);
  return [...days].sort((a, b) => a - b).join(",");
}

/** 把勾选的工具并进现有列表：一行一个，去重，原有顺序在前。 */
export function mergeTools(current: string, picked: string[]): string {
  const lines = current.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const t of picked) if (!lines.includes(t)) lines.push(t);
  return lines.join("\n");
}
