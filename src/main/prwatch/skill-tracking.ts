// 从什么时候起 hook 开始记 skill 事件：之前没有事件不代表没做过 review / design。
import type { SettingsRepo } from "../db/settings-repo";

export interface SkillTrackingDeps {
  settings: Pick<SettingsRepo, "get" | "set">;
  firstSkillAt(): number | null;
  now(): number;
}

/** 已存的开始时间，没有（或不是数字）返回 null。 */
export function skillTrackingSince(settings: Pick<SettingsRepo, "get">): number | null {
  const v = settings.get("skillTrackingSince");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 幂等：已有就原样返回；没有就取 min(最早的 skill 事件, 现在) 存下来。 */
export function ensureSkillTrackingSince(d: SkillTrackingDeps): number {
  const existing = skillTrackingSince(d.settings);
  if (existing !== null) return existing;
  const now = d.now();
  const since = Math.min(d.firstSkillAt() ?? now, now);
  d.settings.set("skillTrackingSince", String(since));
  return since;
}
