// 侧栏树的状态点（UI 重做第 2 层，spec §5.3）：每个 epic、feature、ticket 一个点，颜色是它下面最急的那一项。
import { mostUrgent, type TurnItem } from "../../shared/turn";
import { turnTone, type TurnTone } from "./home-view";

export interface Dot { tone: TurnTone; you: number }

export const dotKey = (kind: "epic" | "feature" | "ticket", id: number | string): string => `${kind}:${id}`;

/**
 * tone 取下面最急的一项（第 1 层的 mostUrgent：你 > agent > 外部，同在「你」里按 YOU_KIND_RANK），
 * you 是下面轮到你的件数；只有合了、没开始的不出点。
 */
export function scopeDots(items: TurnItem[], featureEpic: Map<number, number | null>): Map<string, Dot> {
  const groups = new Map<string, TurnItem[]>();
  const add = (k: string, i: TurnItem) => {
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  };
  for (const i of items) {
    const o = i.turn.owner;
    if (o !== "you" && o !== "agent" && o !== "external") continue;
    if (i.ticketKey !== null) add(dotKey("ticket", i.ticketKey), i);
    if (i.featureId !== null) add(dotKey("feature", i.featureId), i);
    const epic = i.epicId ?? (i.featureId === null ? null : featureEpic.get(i.featureId) ?? null);
    if (epic !== null) add(dotKey("epic", epic), i);
  }
  const out = new Map<string, Dot>();
  for (const [k, g] of groups) {
    const top = mostUrgent(g)!;
    out.set(k, { tone: turnTone(top.turn), you: g.filter((i) => i.turn.owner === "you").length });
  }
  return out;
}

export const youBadge = (n: number): string => (n > 99 ? "99+" : String(n));
