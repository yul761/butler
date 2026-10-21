import type { Brief, NarrativeStatus } from "../../shared/brief";
import type { BriefsRepo } from "../db/briefs-repo";
import type { NarrativeResult } from "../gateway/gateway";
import type { NarrativeSource } from "../gateway/types";

export interface NarrateDeps {
  narrate: (src: NarrativeSource, signal?: AbortSignal) => Promise<NarrativeResult>;
  briefs: Pick<BriefsRepo, "setNarrative">;
  source: (brief: Brief) => NarrativeSource;
  signal?: AbortSignal;
  log?: (msg: string, err?: unknown) => void;
}

const safeLog = (d: NarrateDeps, msg: string, err?: unknown): void => {
  try {
    d.log?.(msg, err);
  } catch {
    // 日志本身出错不能让简报流程出错。
  }
};

/**
 * 早间简报的“今日重点”：尽力而为（设计文档 6.2 / 第 10 节）。
 * 简报已经入库；这里只把结果写回 narrative / narrative_status。任何失败都记成 failed，永远不抛错。
 */
export async function narrateBrief(d: NarrateDeps, brief: Brief): Promise<NarrativeStatus> {
  if (brief.kind !== "morning") return brief.narrativeStatus;
  let r: NarrativeResult;
  try {
    r = await d.narrate(d.source(brief), d.signal);
  } catch (e) {
    safeLog(d, "narrative failed", e);
    r = { status: "failed", narrative: null, auditId: null };
  }
  try {
    d.briefs.setNarrative(brief.id, r.status === "ok" ? r.narrative : null, r.status);
  } catch (e) {
    safeLog(d, "saving the narrative failed", e);
    return "failed";
  }
  return r.status;
}
