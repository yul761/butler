import type { FeatureHandoff } from "../../shared/handoff";
import type { FeatureHandoffTrigger } from "../../shared/types";
import type { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import type { FeaturesRepo } from "../db/features-repo";
import type { TicketsRepo } from "../db/tickets-repo";

export interface FeatureIngestInput {
  featureId: number;
  sessionId: string | null;
  trigger: FeatureHandoffTrigger;
  /** 校验通过的汇总；null 表示 degraded。 */
  payload: FeatureHandoff | null;
  rawText: string | null;
  sourceRef?: string | null;
}

export type FeatureIngestResult =
  | { stored: true; handoffId: number; degraded: boolean }
  | { stored: false; reason: "no_feature" | "duplicate" };

export interface FeatureIngestDeps {
  features: FeaturesRepo;
  tickets: TicketsRepo;
  featureHandoffs: FeatureHandoffsRepo;
  now: () => number;
  /** 存下一份有效（非 degraded）汇总之后调用：让 feature 所在的 epic 重新渲染 handoff。 */
  onValidStored?: (featureId: number) => void;
}

/** 写入一条 feature 汇总（只追加）。next_steps 的 ticket 规范成大写后在本 feature 里找，找不到当 null，文字保留。 */
export function ingestFeatureHandoff(d: FeatureIngestDeps, input: FeatureIngestInput): FeatureIngestResult {
  if (!d.features.get(input.featureId)) return { stored: false, reason: "no_feature" };
  const own = new Set(d.tickets.listByFeature(input.featureId, { includeArchived: true }).map((t) => t.key));
  const payload = input.payload
    ? {
        ...input.payload,
        next_steps: input.payload.next_steps.map((s) => {
          const key = s.ticket?.trim().toUpperCase() ?? null;
          return { ticket: key && own.has(key) ? key : null, text: s.text };
        }),
      }
    : null;
  const id = d.featureHandoffs.insert({
    featureId: input.featureId, sessionId: input.sessionId, trigger: input.trigger, createdAt: d.now(),
    payload, rawText: input.rawText, sourceRef: input.sourceRef ?? null,
  });
  if (id === null) return { stored: false, reason: "duplicate" };
  if (payload !== null) {
    try {
      d.onValidStored?.(input.featureId);
    } catch {
      // 通知失败不能影响汇总入库。
    }
  }
  return { stored: true, handoffId: id, degraded: payload === null };
}
