import type { BackgroundSchedulerDeps } from "../background/scheduler";
import type { RecordEvent } from "../metrics/events";
import type { CostBreakerDeps } from "./cost-breaker";

/**
 * 熔断的每一步记成 H 的度量事件（契约 4.7）：kind 是 cost.<步骤>，ticket 的挂在 ticketKey 上，session 的挂在 sessionId（链的根 id）上。
 * data 只放花了多少、上限、单位和 Butler 自己写的短说明（模型名、上限变化），不放用户写的东西。
 */
export function costMetricEvents(record: RecordEvent): NonNullable<CostBreakerDeps["onEvent"]> {
  return (kind, r) => {
    record(`cost.${kind}`, {
      ...(r.subjectKind === "ticket" ? { ticketKey: r.subjectId } : { sessionId: r.subjectId }),
      data: { subject: r.subjectKind, spent: r.spent, cap: r.cap, unit: r.unit, ...(r.detail && { detail: r.detail }) },
    });
  };
}

/** 后台任务的让路和恢复记成 background.yield / background.resume（契约 4.7），data 是哪种任务和让路的原因。日志照记。 */
export function backgroundMetricEvents(record: RecordEvent, log: (msg: string) => void): NonNullable<BackgroundSchedulerDeps["onEvent"]> {
  return (kind, r) => {
    log(`background: ${kind} ${r.kind}${r.reason ? ` (${r.reason})` : ""}`);
    record(`background.${kind}`, { data: { kind: r.kind, ...(r.reason && { reason: r.reason }) } });
  };
}
