import type { MetricRefs, RecordEvent } from "../metrics/events";

export type { MetricRefs, RecordEvent };

/** 测试和没接度量时用。 */
export const NO_METRICS: RecordEvent = () => false;

/** H 的 recordEvent 承诺不抛错；这里再包一层，不让一个意外挡住闭环。 */
export function safeRecord(record: RecordEvent, kind: string, refs: MetricRefs, log: (msg: string, err?: unknown) => void): boolean {
  try {
    return record(kind, refs);
  } catch (e) {
    log(`metrics: recording ${kind} failed`, e);
    return false;
  }
}
