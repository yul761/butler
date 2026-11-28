// 信息流转（BTL-272）一条要点的几行字：记进了哪里、发给了谁、同步状态到哪一步、能点哪几个按钮。
import type { FlowActionView, FlowItemView } from "../../shared/infoflow";
import { flowLeftoversText } from "./availability-view";
import { retryRequest } from "./close-ticket-outcome";
import type { UiStrings } from "./strings";

/** 「记进了 ticket:BTL-12」「记忆里已经有了，没再发」…… */
export function flowMemoryText(it: Pick<FlowItemView, "memory" | "scope">, S: UiStrings): string {
  const m = S.infoflow.memory;
  return it.memory === "written" ? m.written(it.scope ?? "") : m[it.memory];
}

/** 「发给 BTL-12（已送到）、epic 总控（排队中）」；一个都没有时「没有要发的人」。 */
export function flowDeliveryText(it: Pick<FlowItemView, "deliveries">, S: UiStrings): string {
  if (it.deliveries.length === 0) return S.infoflow.notSent;
  const list = it.deliveries.map((d) => S.infoflow.deliveryItem(d.to, S.infoflow.delivery[d.status ?? "gone"]));
  return `${S.infoflow.sentTo} ${list.join(S.infoflow.listSep)}`;
}

/** 「关掉 BTL-12 · 已同步（自动）」 */
export function flowActionText(a: FlowActionView, S: UiStrings): string {
  const st = S.infoflow.action;
  const left = a.leftovers ? flowLeftoversText(a.leftovers, S) : (a.error ?? "");
  const state =
    a.state === "failed" ? st.failed(a.error ?? "")
    : a.state === "partial" ? (a.leftovers?.closedMeanwhile ? st.partialClosedMeanwhile(left) : st.partial(left))
    // 关的时候别人先关了（BTL-270 的 closedMeanwhile）：本来就是这样，后面跟一句这次实际做了什么。
    : a.state === "already" && a.error ? st.alreadyNote(a.error)
    : st[a.state];
  return `${a.label} · ${a.mode === "auto" && a.state !== "pending" ? S.infoflow.withAuto(state) : state}`;
}

/** 等确认的能照做 / 不用；关了、还有 PR 没关上的能重试 / 就这样 / 撤销；执行了、能撤销的能撤销。 */
export function flowActionButtons(a: FlowActionView): ("apply" | "reject" | "undo" | "retry" | "accept")[] {
  if (a.state === "pending") return ["apply", "reject"];
  if (a.state === "partial") {
    // 剩下的都是再试也关不了的：不给重试，只留「就这样」和撤销（BTL-270 的 retryRequest 是 null）。
    const retry = a.leftovers && retryRequest(a.leftovers) ? ["retry" as const] : [];
    return [...retry, "accept", ...(a.undoable ? ["undo" as const] : [])];
  }
  if (a.undoable) return ["undo"];
  return [];
}
