import { createHash } from "node:crypto";
import { FeatureHandoffSchema, HandoffSchema, upgradeLegacyPr } from "../../shared/handoff";
import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { FeatureIngestInput, FeatureIngestResult } from "./feature-ingest";
import type { IngestInput, IngestResult } from "./ingest";
import { parseJsonLoose, validate } from "./schema";
import { findFeatureHandoffBlock, findHandoffBlock, readLastTurnInfo, type AssistantText, type FoundHandoff } from "./transcript";

export interface StopEvent {
  sessionId: string;
  transcriptPath: string;
}

/** Stop 事件里的 session 和 transcript 路径；Butler 自己的 headless 运行不算。 */
export function stopFromEnvelope(env: HookEnvelope): StopEvent | null {
  if (isHeadlessEnvelope(env)) return null;
  const p = (env.payload && typeof env.payload === "object" ? env.payload : {}) as Record<string, unknown>;
  if (p.hook_event_name !== "Stop") return null;
  const sessionId = typeof p.session_id === "string" ? p.session_id : "";
  const transcriptPath = typeof p.transcript_path === "string" ? p.transcript_path : "";
  return sessionId && transcriptPath ? { sessionId, transcriptPath } : null;
}

export interface CaptureDeps {
  sessions: SessionsRepo;
  tickets: TicketsRepo;
  ingest: (input: IngestInput) => IngestResult;
  ingestFeature: (input: FeatureIngestInput) => FeatureIngestResult;
  /**
   * feature 总控的 /handoff 之后，给这个 feature 下有活动的 ticket 各跑一次 handoff（后台，capture 不等它）。
   * handoffId 是这次存下的汇总；没存下（代码块类型不对、没有代码块）时为 null，这时 Butler 从 sessionId
   * 这个 session fork 出来自己生成汇总（见 FeatureSummaryRunner.runFromCommand、featureCommandFollowup）。
   */
  afterFeatureCommand: (featureId: number, handoffId: number | null, sessionId: string) => void;
  /** 测试注入；默认真的等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/** feature 总控里 /handoff 的结果：wrong_block 是总控输出了 ticket 的 butler-handoff 代码块（不存，记日志）。 */
export type FeatureCaptureResult = { featureId: number } & (FeatureIngestResult | { stored: false; reason: "no_block" | "wrong_block" });

/**
 * Stop hook 有时比 claude 把最后一条回答写进 transcript 还早（Windows 上更常见）：认出是 /handoff、却还没有代码块时，
 * 隔一会儿再读，最多再读这么多次（共约 7 秒）。
 */
export const CAPTURE_RETRY_MS = [500, 1500, 5000];

/**
 * 读最后一轮，确认是 /handoff 后用 pick 找输出；没找到就按 CAPTURE_RETRY_MS 再读。
 * 不是 /handoff、或读不到文件时返回 null；重试用完还没找到时 found 为 null。
 */
async function awaitCommandOutput<T>(d: CaptureDeps, stop: StopEvent, pick: (turn: AssistantText[]) => T | null): Promise<{ found: T | null } | null> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let found: T | null;
    try {
      const last = await readLastTurnInfo(stop.transcriptPath);
      if (!last.isHandoffCommand) return null; // 只收 /handoff 的输出，不收 assistant 随口引用的代码块。
      found = pick(last.turn);
    } catch {
      return null;
    }
    if (found || attempt >= CAPTURE_RETRY_MS.length) return { found };
    await sleep(CAPTURE_RETRY_MS[attempt]);
  }
}

/** 入库去重用：所在 assistant 条目的 uuid；没有的话用 session + 代码块内容的 hash。 */
const sourceRefOf = (stop: StopEvent, found: FoundHandoff): string =>
  found.uuid ?? `${stop.sessionId}:${createHash("sha1").update(found.block).digest("hex")}`;

/**
 * Stop 之后看这一轮有没有 /handoff 的输出，有就入库（trigger=command）。
 * 归属以 Butler 的记录为准：session 是 feature 总控（featureId 不为空）时存成 feature 汇总，见 captureFeatureHandoff；
 * 否则归到 session 已挂的 ticket，没挂的话用代码块里写的 ticket（必须已存在）。
 * 不是 /handoff、或读不到文件时返回 null；是 /handoff 但等了几次都没有代码块时返回 no_block（调用方记日志）。
 */
export async function captureCommandHandoff(d: CaptureDeps, stop: StopEvent): Promise<IngestResult | FeatureCaptureResult | null> {
  const featureId = d.sessions.get(stop.sessionId)?.featureId ?? null;
  if (featureId !== null) return captureFeatureHandoff(d, stop, featureId);
  const r = await awaitCommandOutput(d, stop, findHandoffBlock);
  if (!r) return null;
  const found = r.found;
  if (!found) return { stored: false, reason: "no_block" };
  // 旧版本的 /handoff 命令输出单个 pr：先换成 prs 再校验。
  const checked = validate(HandoffSchema, upgradeLegacyPr(parseJsonLoose(found.block)));
  const claimed = checked.ok ? checked.value.ticket.trim().toUpperCase() : null;
  const ticketKey = d.sessions.get(stop.sessionId)?.ticketKey ?? (claimed && d.tickets.get(claimed) ? claimed : null);
  if (!ticketKey) return { stored: false, reason: "no_ticket" };
  return d.ingest({
    ticketKey, sessionId: stop.sessionId, trigger: "command",
    payload: checked.ok ? checked.value : null, rawText: found.block, sourceRef: sourceRefOf(stop, found),
  });
}

/**
 * feature 总控里的 /handoff：只收 butler-feature-handoff 代码块（没有时退回看起来是 feature 汇总的 ```json 代码块），
 * 存成这个 feature 的汇总（校验失败存成 degraded）。
 * 总控按旧习惯输出了 ticket 的 butler-handoff 代码块时，当作没有输出（wrong_block）：总控不属于任何 ticket，代码块里的 ticket 号也不能认领它。
 * 存下新汇总、wrong_block、no_block 都调用 afterFeatureCommand（后两种 handoffId 为 null：用户自己开的总控没有 Butler 的
 * MCP，常常写不出 feature 代码块，由调用方退回 Butler 自己生成）；duplicate 不调用（第一次采集已经调用过）。
 */
async function captureFeatureHandoff(d: CaptureDeps, stop: StopEvent, featureId: number): Promise<FeatureCaptureResult | null> {
  const r = await awaitCommandOutput(d, stop, (turn) => {
    const feature = findFeatureHandoffBlock(turn);
    if (feature) return { feature };
    return findHandoffBlock(turn) ? { feature: null } : null;
  });
  if (!r) return null;
  const found = r.found?.feature;
  if (!found) {
    d.afterFeatureCommand(featureId, null, stop.sessionId);
    return { featureId, stored: false, reason: r.found ? "wrong_block" : "no_block" };
  }
  const checked = validate(FeatureHandoffSchema, parseJsonLoose(found.block));
  const res = d.ingestFeature({
    featureId, sessionId: stop.sessionId, trigger: "command",
    payload: checked.ok ? checked.value : null, rawText: found.block, sourceRef: sourceRefOf(stop, found),
  });
  if (res.stored) d.afterFeatureCommand(featureId, res.handoffId, stop.sessionId);
  return { featureId, ...res };
}
