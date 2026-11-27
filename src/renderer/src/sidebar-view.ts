// 侧栏树的状态点（UI 重做第 2 层，spec §5.3）：每个 feature、ticket 一个点，颜色是它下面最急的那一项。
import { mostUrgent, type TurnItem } from "../../shared/turn";
import { turnTone, type TurnTone } from "./home-view";

export interface Dot { tone: TurnTone; you: number }

export const dotKey = (kind: "feature" | "ticket", id: number | string): string => `${kind}:${id}`;

/**
 * tone 取下面最急的一项（第 1 层的 mostUrgent：你 > agent > 外部，同在「你」里按 YOU_KIND_RANK），
 * you 是下面轮到你的件数；只有合了、没开始的不出点。
 */
export function scopeDots(items: TurnItem[]): Map<string, Dot> {
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
  }
  const out = new Map<string, Dot>();
  for (const [k, g] of groups) {
    const top = mostUrgent(g)!;
    out.set(k, { tone: turnTone(top.turn), you: g.filter((i) => i.turn.owner === "you").length });
  }
  return out;
}

export const youBadge = (n: number): string => (n > 99 ? "99+" : String(n));

/** 两份点的内容一样（BTL-277）：一样就留着旧的 Map，memo 的侧栏不跟着重画。 */
export function sameDots(a: Map<string, Dot>, b: Map<string, Dot>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, d] of a) {
    const o = b.get(k);
    if (!o || o.tone !== d.tone || o.you !== d.you) return false;
  }
  return true;
}
