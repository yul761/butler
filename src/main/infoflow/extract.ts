import { z } from "zod";
import { truncateUnits } from "../../shared/memory";
import { FLOW_IMPORTANCE, FLOW_KINDS, FLOW_MAX_ITEMS, FLOW_TEXT_LIMIT, type FlowImportance, type FlowKind, type FlowSpeaker } from "../../shared/infoflow";
import { headlessArgs } from "../claude/headless";
import { execHeadlessJson, type HeadlessExecDeps } from "../handoff/headless-exec";
import { toCliJsonSchema } from "../handoff/schema";
import { currentLang } from "../i18n";
import { maskSecrets, SECRET_MASK } from "./secrets";

/**
 * 信息流转（BTL-272）：请低档模型（任务 conv_relay）从一轮对话里抽要点。
 * 不给任何工具；模型的输出一律当作不可信：逐条校验，坏的条目丢掉，整体不成形就当这一轮没抽到（不写、不发、不执行）。
 */

/** 模型看到的上下文：这一轮是谁的、能指向哪些 ticket / epic / feature。 */
export interface ExtractContext {
  /** 「BTL-12 的 ticket session」「epic 登录改版（id 4）的总控」「全局总控」「BTL-12 的修复 session」。 */
  source: string;
  epics: { id: number; name: string }[];
  tickets: { key: string; title: string | null; epicId: number | null; feature: string | null; status: string }[];
  /** 各 epic 里的 feature（内部叫 block）。 */
  features: { id: number; epicId: number; name: string }[];
}

const ChangeSchema = z.object({
  op: z.enum(["close_ticket", "set_ticket_feature", "prioritize_feature"]),
  ticket: z.string().optional(),
  /** set_ticket_feature：feature 的名字或 id；null 移出所有 feature。prioritize_feature：要排到最前的 feature。 */
  feature: z.union([z.string(), z.number(), z.null()]).optional(),
  reason: z.string().optional(),
  closePrs: z.boolean().optional(),
});

const ItemSchema = z.object({
  text: z.string(),
  kind: z.enum(FLOW_KINDS),
  speaker: z.enum(["user", "agent"]),
  quote: z.string(),
  targets: z.array(z.string()),
  importance: z.enum(FLOW_IMPORTANCE),
  confidence: z.number(),
  change: ChangeSchema.nullable().optional(),
});

const OutputSchema = z.object({ items: z.array(ItemSchema) });
export const FLOW_JSON_SCHEMA = toCliJsonSchema(OutputSchema);

export interface RawChange {
  op: "close_ticket" | "set_ticket_feature" | "prioritize_feature";
  ticket: string | null;
  feature: string | number | null | undefined;
  reason: string | null;
  closePrs: boolean;
}

/** 校验过的一条（targets 还是模型写的字符串，由 resolveTargets 解析）。 */
export interface ExtractedItem {
  text: string;
  kind: FlowKind;
  speaker: FlowSpeaker;
  quote: string;
  targets: string[];
  importance: FlowImportance;
  confidence: number;
  change: RawChange | null;
}

export type ParseResult = { ok: true; items: ExtractedItem[]; dropped: number } | { ok: false; error: string };

/** 压空白，按 UTF-16 单位截到 n（和记忆的上限同一个量法），不切开代理对。 */
const clean = (s: string, n: number): string => truncateUnits(s.replace(/\s+/g, " ").trim(), n).trim();
/** 压空白、密钥打码（先打码再截：截断不会切开一个 token、留下半截），截到 n。 */
const safe = (s: string, n: number): string => clean(maskSecrets(s.replace(/\s+/g, " ")), n);

/**
 * 模型的输出 → 校验过的条目。不是对象、没有 items 数组：整体失败。单条不成形（缺字段、类型不对、正文为空、置信度不是数字）
 * 就丢掉这一条，别的照收；最多收 FLOW_MAX_ITEMS 条。正文压空白、截到 FLOW_TEXT_LIMIT，置信度夹到 [0, 1]。
 */
export function parseExtraction(value: unknown): ParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "not an object" };
  const raw = (value as { items?: unknown }).items;
  if (!Array.isArray(raw)) return { ok: false, error: "items is not an array" };
  const items: ExtractedItem[] = [];
  let dropped = 0;
  for (const r of raw) {
    const p = ItemSchema.safeParse(r);
    if (!p.success || items.length >= FLOW_MAX_ITEMS) {
      dropped++;
      continue;
    }
    const v = p.data;
    // 要点会写进记忆、发进信箱、存进库：text、quote、reason 里认得出的 token、密码、私钥一律打码；打完码只剩占位符的整条丢掉。
    const text = safe(v.text, FLOW_TEXT_LIMIT);
    if (!text || text.split(SECRET_MASK).join("").replace(/[\s\p{P}]/gu, "").length < 2 || !Number.isFinite(v.confidence)) {
      dropped++;
      continue;
    }
    const c = v.change ?? null;
    items.push({
      text,
      kind: v.kind,
      speaker: v.speaker,
      quote: safe(v.quote, 300),
      targets: [...new Set(v.targets.map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 200))].slice(0, 8),
      importance: v.importance,
      confidence: Math.min(1, Math.max(0, v.confidence)),
      change: c && {
        op: c.op,
        // ticket、feature 也会拼进卡片、发给总控：一样打码、截短。
        ticket: c.ticket ? safe(c.ticket, 64) || null : null,
        feature: typeof c.feature === "string" ? safe(c.feature, 200) : c.feature,
        reason: c.reason ? safe(c.reason, 300) || null : null,
        closePrs: c.closePrs === true,
      },
    });
  }
  return { ok: true, items, dropped };
}

const list = <T>(xs: T[], n: number, f: (x: T) => string): string => (xs.length === 0 ? "-" : xs.slice(0, n).map(f).join("\n"));

export function extractPrompt(ctx: ExtractContext, turn: { userText: string; agentText: string }): string {
  const epics = list(ctx.epics, 30, (e) => `- epic:${e.id} ${e.name}`);
  const tickets = list(ctx.tickets, 80, (t) => `- ticket:${t.key} ${t.title ?? ""} [${t.status}]${t.epicId !== null ? ` epic:${t.epicId}` : ""}${t.feature ? ` feature「${t.feature}」` : ""}`);
  const features = list(ctx.features, 60, (f) => `- ${f.id} 「${f.name}」 epic:${f.epicId}`);
  if (currentLang() === "en") {
    return [
      "You read one round of conversation between the user and a coding agent session managed by Shipherd, and pull out what other sessions need to know.",
      `This round is from: ${ctx.source}.`,
      "Only pull out things that matter beyond this round: decisions, conventions, constraints, state changes (a ticket is dropped, moves to another feature, should be done first…), and facts others need (fyi).",
      "Skip progress chatter, plans for the next few minutes, code details that only this session cares about, and anything already obvious. Most rounds have nothing: then return an empty list.",
      "For each item give:",
      "- text: one self-contained sentence anyone can understand without this conversation (name the ticket, PR or interface).",
      "- kind: decision | convention | constraint | state_change | fyi.",
      "- speaker: user if the user said it, agent if only the agent said it.",
      "- quote: a short verbatim excerpt (under 100 characters) of what was actually said, copied exactly.",
      "Never copy a token, password, API key, private key or any other secret into text, quote or reason: write [REDACTED] in its place.",
      "- targets: who must know, from: ticket:<KEY>, epic:<id>, coordinator:<epic id>, coordinator:global, workspace. Use the narrowest that covers it.",
      "- importance: high (others will do the wrong thing without it, or it changes what they are working on now), normal, low.",
      "- confidence: 0 to 1, how sure you are this is really what was decided.",
      "- change: only for state_change that Shipherd can apply, else null: {op: close_ticket, ticket, reason, closePrs} (ticket dropped / not doing it; closePrs only if they said to close the PR too), {op: set_ticket_feature, ticket, feature (name or id, null = no feature)}, {op: prioritize_feature, feature} (do that feature first).",
      "Answer as JSON only: {\"items\": [...]}.",
      "",
      "Epics:", epics, "", "Tickets:", tickets, "", "Features (id, name, epic):", features,
      "", "User said:", turn.userText || "(nothing)", "", "Agent said:", turn.agentText || "(nothing)",
    ].join("\n");
  }
  return [
    "你在读用户和一个由 Shipherd 管理的写代码 agent session 之间的一轮对话，把别的 session 需要知道的东西抽出来。",
    `这一轮来自：${ctx.source}。`,
    "只抽这一轮之外也重要的：决定、约定、限制、状态变化（ticket 不做了、换到别的 feature、要先做……），以及别人需要知道的事实（fyi）。",
    "进度汇报、接下来几分钟的打算、只有这个 session 关心的代码细节、显而易见的事都不要。大多数轮什么都没有，那就返回空列表。",
    "每条给出：",
    "- text：一句自成一体的话，不看这段对话也能懂（写明是哪个 ticket、PR、接口）。",
    "- kind：decision | convention | constraint | state_change | fyi。",
    "- speaker：用户说的写 user，只有 agent 说的写 agent。",
    "- quote：原话的一小段（100 字以内），一字不差地抄。",
    "token、密码、API key、私钥这类密钥一律不要抄进 text、quote、reason：换成 [REDACTED]。",
    "- targets：谁必须知道，从这些里选：ticket:<号>、epic:<id>、coordinator:<epic id>、coordinator:global、workspace。选能覆盖到的最小范围。",
    "- importance：high（不知道就会做错，或者改变了对方手上正在做的事）、normal、low。",
    "- confidence：0 到 1，你有多确定这真的是定下来的。",
    "- change：只有 Shipherd 能执行的 state_change 才填，否则 null：{op: close_ticket, ticket, reason, closePrs}（ticket 不做了；用户也说了关 PR 才写 closePrs）、{op: set_ticket_feature, ticket, feature（名字或 id，null 是不属于任何 feature）}、{op: prioritize_feature, feature}（那个 feature 先做）。",
    "只用 JSON 回答：{\"items\": [...]}。",
    "",
    "epic：", epics, "", "ticket：", tickets, "", "feature（id、名字、所属 epic）：", features,
    "", "用户说：", turn.userText || "（没说话）", "", "agent 说：", turn.agentText || "（没说话）",
  ].join("\n");
}

/** 一时的失败：花费熔断、限流、超时、还没装 claude、退出时中断。这一轮留着，过一会儿再抽。 */
const LATER: ReadonlySet<string> = new Set(["cost_paused", "rate_limited", "timeout", "claude_missing", "aborted"]);

export type ExtractOutcome = { ok: true; items: ExtractedItem[]; dropped: number } | { ok: false; later: boolean; error: string };

/** 跑一次抽取。永不 reject：异常当作失败（不重试）。 */
export async function extractTurn(
  d: HeadlessExecDeps,
  ctx: ExtractContext,
  turn: { userText: string; agentText: string },
  o: { cwd: string; ticketKey: string | null },
): Promise<ExtractOutcome> {
  try {
    const r = await execHeadlessJson(d, {
      task: "conv_relay",
      label: "conv relay extract",
      args: headlessArgs({ schema: FLOW_JSON_SCHEMA, allowedTools: [] }),
      prompt: extractPrompt(ctx, turn),
      cwd: o.cwd,
      ticketKey: o.ticketKey,
    });
    if (!r.ok) return { ok: false, later: LATER.has(r.reason), error: r.reason };
    const p = parseExtraction(r.value);
    return p.ok ? p : { ok: false, later: false, error: `bad_output: ${p.error}` };
  } catch (e) {
    return { ok: false, later: false, error: e instanceof Error ? e.message : String(e) };
  }
}
