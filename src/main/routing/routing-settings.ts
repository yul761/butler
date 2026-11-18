import type { SettingsRepo } from "../db/settings-repo";
import { M } from "../strings";
import type { RoutingSettings } from "./routing-service";
import { parseEffort, parseMaxConcurrent } from "./routing-service";
import { parseQuotas, parseThresholds } from "./spend";

/** 设置里存的 JSON：空串是没设；不是 JSON 的抛 bad。 */
function json(value: string, bad: string): unknown | null {
  const t = value.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    throw new RoutingSettingError(bad);
  }
}

export class RoutingSettingError extends Error {}

type RoutingKey = "routingQuotas" | "routingThresholds" | "routingPeriodStartDay" | "routingEffort" | "routingMaxConcurrent" | "routingAutoSwitch";

/** 路由设置的检查和规范化：有一条不合法就整个拒绝（不悄悄丢掉）。 */
export function normalizeRoutingSetting(key: RoutingKey, value: string): string {
  const s = M().routing;
  switch (key) {
    case "routingQuotas": {
      const v = json(value, s.badQuotas);
      if (v === null) return "";
      if (!Array.isArray(v)) throw new RoutingSettingError(s.badQuotas);
      const ok = parseQuotas(JSON.stringify(v));
      if (ok.length !== v.length) throw new RoutingSettingError(s.badQuotas);
      return ok.length === 0 ? "" : JSON.stringify(ok);
    }
    case "routingThresholds": {
      const t = value.trim();
      const parts = t.split(",").map((x) => x.trim());
      if (parts.length !== 2 || parts.some((p) => !/^\d{1,3}$/.test(p))) throw new RoutingSettingError(s.badThresholds);
      const [a, b] = parts.map(Number) as [number, number];
      if (a < 1 || b > 100 || a >= b) throw new RoutingSettingError(s.badThresholds);
      const [x, y] = parseThresholds(`${a},${b}`);
      return `${Math.round(x * 100)},${Math.round(y * 100)}`;
    }
    case "routingPeriodStartDay": {
      const t = value.trim();
      if (!/^\d{1,2}$/.test(t) || Number(t) < 1 || Number(t) > 28) throw new RoutingSettingError(s.badPeriodDay);
      return String(Number(t));
    }
    case "routingEffort":
    case "routingMaxConcurrent": {
      const bad = key === "routingEffort" ? s.badEffort : s.badMaxConcurrent;
      const v = json(value, bad);
      if (v === null) return "";
      if (typeof v !== "object" || Array.isArray(v)) throw new RoutingSettingError(bad);
      const raw = JSON.stringify(v);
      const ok = key === "routingEffort" ? parseEffort(raw) : parseMaxConcurrent(raw);
      if (Object.keys(ok).length !== Object.keys(v).length) throw new RoutingSettingError(bad);
      return Object.keys(ok).length === 0 ? "" : JSON.stringify(ok);
    }
    case "routingAutoSwitch": {
      const t = value.trim();
      if (t !== "0" && t !== "1") throw new RoutingSettingError(s.badFlag);
      return t;
    }
  }
}

/** RoutingService 读的设置。 */
export function routingSettings(settings: Pick<SettingsRepo, "get">): RoutingSettings {
  const day = Number(settings.get("routingPeriodStartDay"));
  return {
    quotas: settings.get("routingQuotas"),
    thresholds: settings.get("routingThresholds"),
    periodStartDay: Number.isInteger(day) && day >= 1 && day <= 28 ? day : 1,
    effort: settings.get("routingEffort"),
    maxConcurrent: settings.get("routingMaxConcurrent"),
    autoSwitch: settings.get("routingAutoSwitch") === "1",
  };
}
