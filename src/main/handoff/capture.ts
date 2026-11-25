import { createHash } from "node:crypto";
import { FeatureHandoffSchema, HandoffSchema, upgradeLegacyPr, type FeatureHandoff, type Handoff } from "../../shared/handoff";
import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { currentLang } from "../i18n";
import type { FeatureIngestInput, FeatureIngestResult } from "./feature-ingest";
import type { IngestInput, IngestResult } from "./ingest";
import { parseJsonLoose, validate } from "./schema";
import { findFeatureHandoffBlock, findHandoffBlock, readLastTurnInfo, type AssistantText, type FoundHandoff } from "./transcript";

export interface StopEvent {
  sessionId: string;
  transcriptPath: string;
}

/** Stop 事件里的 session 和 transcript 路径；Shipherd 自己的 headless 运行不算。 */
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
   * handoffId 是这次存下的汇总；没存下（代码块类型不对、没有代码块）时为 null，这时 Shipherd 从 sessionId
   * 这个 session fork 出来自己生成汇总（见 FeatureSummaryRunner.runFromCommand、featureCommandFollowup）。
   */
  afterFeatureCommand: (featureId: number, handoffId: number | null, sessionId: string) => void;
  /** 测试注入；默认真的等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * feature 总控里 /handoff 的结果。总控输出了 ticket 的 shipherd-handoff 代码块时：能换成 feature 汇总就存下，fromTicketBlock 为 true
 * （调用方记日志）；换不成（校验不过、没有内容）就是 wrong_block（不存，记日志）。
 */
export type FeatureCaptureResult = { featureId: number } & ((FeatureIngestResult & { fromTicketBlock?: true }) | { stored: false; reason: "no_block" | "wrong_block" });

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
 * 归属以 Shipherd 的记录为准：session 是 feature 总控（featureId 不为空）时存成 feature 汇总，见 captureFeatureHandoff；
 * 否则归到 session 已挂的 ticket，没挂的话用代码块里写的 ticket（必须已存在）。
 * 修复 session 不是总控，也不接手 ticket 的工作：它的 /handoff 不收，返回 null。
 * 以前的 epic session（BTL-246 去掉了）也不收：代码块里的 ticket 号不能认领它。
 * Shipherd 总控同理：它的汇总写进 shipherd-workspace 记忆，不能被当成哪个 ticket 的 handoff。
 * 不是 /handoff、或读不到文件时返回 null；是 /handoff 但等了几次都没有代码块时返回 no_block（调用方记日志）。
 */
export async function captureCommandHandoff(d: CaptureDeps, stop: StopEvent): Promise<IngestResult | FeatureCaptureResult | null> {
  const session = d.sessions.get(stop.sessionId);
  if (session?.fixesSession || session?.shipherd || d.sessions.isLegacyEpic(stop.sessionId)) return null;
  const featureId = session?.featureId ?? null;
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
 * 总控误写成 ticket handoff 时（BTL-267），按总控身份换成 feature 汇总：blockers、decisions、open_questions 原样搬过去；
 * next_steps 每条一项，ticket 填 null（代码块里的 ticket 号多半是总控所在 worktree 的 ticket，不能说明每一步属于谁）；
 * summary 用 done_today 拼成一段，没有就用 blockers，再没有就用 next_steps。
 * prs、jira、followups、learnings、status 汇总里没有对应的字段，丢掉（PR 汇总时由 Shipherd 实时读）。拼不出 summary（什么都没写）时返回 null。
 */
export function featureHandoffFromTicket(h: Handoff): FeatureHandoff | null {
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter((x) => x.length > 0);
  const nextSteps = clean(h.next_steps);
  const parts = [clean(h.done_today), clean(h.blockers), nextSteps].find((xs) => xs.length > 0) ?? [];
  const summary = parts.join(currentLang() === "en" ? "; " : "；");
  const converted = {
    summary,
    blockers: clean(h.blockers),
    next_steps: nextSteps.map((text) => ({ ticket: null, text })),
    decisions: h.decisions,
    open_questions: clean(h.open_questions),
  };
  const checked = validate(FeatureHandoffSchema, converted);
  return checked.ok ? checked.value : null;
}

/**
 * feature 总控里的 /handoff：只收 shipherd-feature-handoff 代码块（没有时退回看起来是 feature 汇总的 ```json 代码块），
 * 存成这个 feature 的汇总（校验失败存成 degraded）。
 * 总控输出了 ticket 的 shipherd-handoff 代码块时（BTL-267：判断错了身份，比如在某个 ticket 的 worktree 里），代码块里的 ticket 号
 * 不能认领它（总控不属于任何 ticket），而是按总控身份换成 feature 汇总存下（featureHandoffFromTicket，fromTicketBlock）：
 * 否则换新要白等 10 分钟然后放弃。换不成（校验不过、没有内容）时当作没有输出（wrong_block）。
 * 存下新汇总、wrong_block、no_block 都调用 afterFeatureCommand；后两种和从 ticket 代码块换来的汇总 handoffId 为 null：用户自己开的
 * 总控没有 Shipherd 的 MCP，常常写不出 feature 代码块，由调用方退回 Shipherd 自己生成（换来的那份缺 PR 等字段，生成的更完整，
 * 存下后取代它；换新期间不生成，见 index.ts 的 afterFeatureCommand）。duplicate 不调用（第一次采集已经调用过）。
 */
async function captureFeatureHandoff(d: CaptureDeps, stop: StopEvent, featureId: number): Promise<FeatureCaptureResult | null> {
  const r = await awaitCommandOutput(d, stop, (turn) => {
    const feature = findFeatureHandoffBlock(turn);
    if (feature) return { feature, ticket: null };
    const ticket = findHandoffBlock(turn);
    return ticket ? { feature: null, ticket } : null;
  });
  if (!r) return null;
  const found = r.found?.feature;
  const ticketBlock = r.found?.ticket ?? null;
  if (!found && ticketBlock) {
    const checked = validate(HandoffSchema, upgradeLegacyPr(parseJsonLoose(ticketBlock.block)));
    const payload = checked.ok ? featureHandoffFromTicket(checked.value) : null;
    if (payload) {
      const res = d.ingestFeature({
        featureId, sessionId: stop.sessionId, trigger: "command",
        payload, rawText: ticketBlock.block, sourceRef: sourceRefOf(stop, ticketBlock),
      });
      if (res.stored) d.afterFeatureCommand(featureId, null, stop.sessionId);
      return res.stored ? { featureId, ...res, fromTicketBlock: true } : { featureId, ...res };
    }
  }
  if (!found) {
    d.afterFeatureCommand(featureId, null, stop.sessionId);
    return { featureId, stored: false, reason: ticketBlock ? "wrong_block" : "no_block" };
  }
  const checked = validate(FeatureHandoffSchema, parseJsonLoose(found.block));
  const res = d.ingestFeature({
    featureId, sessionId: stop.sessionId, trigger: "command",
    payload: checked.ok ? checked.value : null, rawText: found.block, sourceRef: sourceRefOf(stop, found),
  });
  if (res.stored) d.afterFeatureCommand(featureId, res.handoffId, stop.sessionId);
  return { featureId, ...res };
}
