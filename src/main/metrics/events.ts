import type { MetricData, MetricsRepo } from "../db/metrics-repo";
import type { MetricKindGroup } from "../../shared/metrics";

/** 记一条度量事件时可以带的关联（契约 4.7）。 */
export interface MetricRefs {
  sessionId?: string | null;
  ticketKey?: string | null;
  /** ticket_prs.id */
  prId?: number | null;
  repoSlug?: string | null;
  /** 默认 now()。 */
  at?: number;
  /** 小的 JSON 对象：类别、子类型、来源。不放用户写的原文（问题、回复、命令）。 */
  data?: Record<string, unknown>;
  /** 同一个 key 只记一次（重试、重复观察）。 */
  dedupeKey?: string;
}

/** 别的 workstream 拿到的就是这个函数：永不抛错，记下了返回 true（重复的 dedupeKey、坏的 kind 返回 false）。 */
export type RecordEvent = (kind: string, refs?: MetricRefs) => boolean;

/** 认识的 kind 和它的归类；不在表里的也收，「效果」页放进"其他事件"。 */
export const METRIC_KINDS: Readonly<Record<string, MetricKindGroup>> = {
  terminal_input: "intervention",
  needs_you_answer: "intervention",
  manual_merge: "intervention",
  manual_trigger: "intervention",
  agent_merge: "other",
  interrupt: "interrupt",
  interrupt_auto_resolved: "interrupt",
  pr_reopened: "rework",
  pr_reverted: "rework",
  comment_auto_handled: "comment",
  "cost.warn": "other",
  "cost.downgrade": "other",
  "cost.pause": "other",
  "cost.stop": "other",
  "cost.takeover": "other",
  "cost.resume": "other",
  "cost.raise": "other",
  "background.yield": "other",
  "background.resume": "other",
};

/** 算人介入的 kind。 */
export const INTERVENTION_KINDS: readonly string[] = Object.entries(METRIC_KINDS)
  .filter(([, g]) => g === "intervention")
  .map(([k]) => k);

/** snake_case，可以有一个点号分的前缀。 */
const KIND_RE = /^[a-z][a-z0-9_]{0,40}(?:\.[a-z][a-z0-9_]{0,40})?$/;
/** data 最多几个键、字符串最多多长（只该放类别这类短值）。 */
const DATA_KEYS = 16;
const DATA_STRING = 120;

export const isMetricKind = (kind: string): boolean => KIND_RE.test(kind);

/** 只留标量；字符串截短；对象、数组、函数丢掉。 */
export function cleanData(data: Record<string, unknown> | undefined): MetricData {
  const out: MetricData = {};
  if (!data) return out;
  for (const [k, v] of Object.entries(data).slice(0, DATA_KEYS)) {
    if (typeof v === "string") out[k] = v.slice(0, DATA_STRING);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean" || v === null) out[k] = v;
  }
  return out;
}

export interface MetricsDeps {
  repo: Pick<MetricsRepo, "addEvent">;
  now: () => number;
  log?: (msg: string, err?: unknown) => void;
}

/** 度量事件的入口（契约 4.7）：其他 workstream 也通过它记事件，不自己加计数器。 */
export class Metrics {
  constructor(private readonly d: MetricsDeps) {}

  readonly recordEvent: RecordEvent = (kind, refs = {}) => {
    if (!isMetricKind(kind)) {
      this.d.log?.(`metrics: ignoring an event with a bad kind ${JSON.stringify(kind.slice(0, 60))}`);
      return false;
    }
    try {
      return this.d.repo.addEvent({
        kind,
        at: refs.at ?? this.d.now(),
        sessionId: refs.sessionId ?? null,
        ticketKey: refs.ticketKey ?? null,
        prId: refs.prId ?? null,
        repoSlug: refs.repoSlug ?? null,
        data: cleanData(refs.data),
        dedupeKey: refs.dedupeKey ?? null,
      });
    } catch (e) {
      this.d.log?.(`metrics: recording a ${kind} event failed`, e);
      return false;
    }
  };
}
