import type { ModelHealthView, RoutingView, Tier } from "../../shared/model-routing";
import type { Tone } from "./lesson-runs-view";
import { timeText } from "./lesson-runs-view";
import type { UiStrings } from "./strings";

export const HEALTH_TONE: Record<ModelHealthView["state"], Tone> = { ok: "ok", limited: "warn", unavailable: "danger", probing: "muted" };

/** 健康一栏的文字：状态、疑似、到什么时候。 */
export function healthText(h: ModelHealthView | undefined, S: UiStrings): string {
  if (!h) return S.rt.health.ok;
  const parts = [S.rt.health[h.state] ?? h.state];
  if (h.suspected) parts.push(S.rt.suspected);
  if (h.state === "limited" || h.state === "unavailable") parts.push(h.until !== null && h.resetKnown ? S.rt.until(timeText(h.until)) : S.rt.untilUnknown);
  return parts.join(" · ");
}

/** 一档的显式顺序写成输入框里的文字。 */
export const chainText = (v: RoutingView, tier: Tier): string => v.chains[tier].join(", ");

/** 输入框的文字 → 模型名列表（逗号或换行分隔，去空、去重）。 */
export function parseChain(text: string): string[] {
  const out: string[] = [];
  for (const n of text.split(/[,\n]/).map((x) => x.trim())) if (n && !out.includes(n)) out.push(n);
  return out;
}
