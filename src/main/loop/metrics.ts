/**
 * 度量事件（契约 4.7，工作流 H）。H 的 #46 合并之前，这里放一份同签名的类型，index.ts 传 NO_METRICS；
 * 合并以后换成 `import type { RecordEvent } from "../metrics/events"`，index.ts 传 H 的 recordEvent。
 */

export type MetricScalar = string | number | boolean | null;

export interface MetricRefs {
  sessionId?: string | null;
  ticketKey?: string | null;
  prId?: number | null;
  repoSlug?: string | null;
  at?: number;
  data?: Record<string, MetricScalar>;
  /** 同一个 dedupeKey 只记一次（重复返回 false）。 */
  dedupeKey?: string;
}

/** 永不抛错；记下了返回 true。 */
export type RecordEvent = (kind: string, refs?: MetricRefs) => boolean;

export const NO_METRICS: RecordEvent = () => false;

/** 调用方再包一层：H 的实现承诺不抛错，这里也不让一个意外挡住闭环。 */
export function safeRecord(record: RecordEvent, kind: string, refs: MetricRefs, log: (msg: string, err?: unknown) => void): boolean {
  try {
    return record(kind, refs);
  } catch (e) {
    log(`metrics: recording ${kind} failed`, e);
    return false;
  }
}
