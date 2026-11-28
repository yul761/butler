import type { ClosedMeanwhile, ClosePrError } from "../../shared/close-ticket-outcome";
import { maskSecrets } from "./secrets";
import { FLOW_AUTO_CONFIDENCE, type FlowChange, type FlowSpeaker } from "../../shared/infoflow";
import type { RawChange } from "./extract";
import { normalizeFact } from "./dedupe";

/**
 * 信息流转（BTL-272）：对话里说的状态变化 → Shipherd 里能执行的一步。
 * 只认三种，都能撤销：关掉 ticket（重开）、ticket 换 feature（换回去）、某个 feature 先做（排回原来的顺序）。
 */

export interface ActionWorld {
  /** 按号找 ticket（不分大小写）。featureId 是 epic，blockId 是 epic 里的 feature。 */
  ticket(key: string): { key: string; featureId: number | null; blockId: number | null; closed: boolean } | null;
  /** epic 里的 feature，按 id 或名字（不分大小写）；epicId 为 null 时在所有 epic 里找，名字重了就算找不到。 */
  block(epicId: number | null, ref: string | number): { id: number; featureId: number } | null;
  /** epic 里 feature 的顺序（id，排前面的先做）。 */
  blockOrder(featureId: number): number[];
}

/** 执行状态变化用的操作；关 ticket 用 BTL-270 的 closeTicket / reopenTicket。 */
/** 关 ticket 时没处理完的：没关上的 PR、没结束的 session（BTL-270 的分项报告）。 */
export interface CloseLeftovers {
  prErrors: ClosePrError[];
  sessionErrors: { id: string; error: string }[];
  /** 关的时候别人先关了这个 ticket：剩下的照样能重试、能「就这样」，但 ticket 不是这里关的，不给撤销（撤销是重新打开）。 */
  closedMeanwhile?: true;
}

/**
 * 关 ticket 这一下的结果（按 shared 的 closeOutcome 判断，和关闭对话框同一个判断）：done 全做完了；partial ticket 关了、
 * 还有没处理完的（不算完成：等你重试或者「就这样」）；reopened 关的时候被重新打开了（不算同步了）。
 */
export type CloseStep =
  | { kind: "done" }
  | { kind: "partial"; leftovers: CloseLeftovers }
  | { kind: "reopened" }
  /**
   * 关的时候别人（总控、你在关闭框里）先关了这个 ticket（BTL-270 的 closedMeanwhile）：ticket 不是这里关的，记成本来就是这样（already），
   * 不给撤销。how 是这次实际做了什么：prs 关了点名的 PR，sessions 结束了 session，both 两样都做了，nothing 没有要再做的（already_closed）。
   * 有没处理成的（closedMeanwhile 是 failed）不走这里，走 partial（leftovers.closedMeanwhile）。
   */
  | { kind: "closed_meanwhile"; how: Exclude<ClosedMeanwhile, "failed"> }
  /**
   * 要关 PR 却没点名（BTL-270 的 pick_prs，prUrls 没给）：什么都没做，这是现在能关的和关不了的，换成这份再问你一次。
   * 点名了的不会走到这里：BTL-270 只关点名里现在还开着、能关的那几个（交集），别的不动、不再问。
   */
  | { kind: "pick"; prs: ClosePrs };

/** 关 ticket 时它开着的 PR：能关的（链接）和关不了的（链接和原因）。 */
export interface ClosePrs {
  closable: string[];
  unclosable: { url: string; error: string }[];
}

export interface TicketActions {
  /** 关掉；closePrs 时顺便关 prUrls 点名的 PR（卡片上列给你看过的）。ticket 没关上抛错，其余的分项报告。 */
  closeTicket(key: string, reason: string, closePrs: boolean, prUrls?: string[]): Promise<CloseStep>;
  /** 这个 ticket 开着的 PR 里哪些能关、哪些不能（BTL-270 的 closePreview）；没有这个 ticket 为 null。 */
  previewClose(key: string): Promise<ClosePrs | null>;
  /** 关了以后重试上次没处理完的（BTL-270 的 retryClose）。ticket 已经不是关着的：reopened。 */
  retryClose(key: string, leftovers: CloseLeftovers): Promise<CloseStep>;
  reopenTicket(key: string): Promise<void>;
  setBlock(key: string, blockId: number | null): void;
  reorderBlocks(featureId: number, ids: number[]): void;
}

/** 撤销用的：执行前的状态。 */
export type FlowUndo =
  | { op: "reopen_ticket"; ticket: string }
  | { op: "set_ticket_feature"; ticket: string; blockId: number | null }
  | { op: "reorder_features"; featureId: number; order: number[] };

/** 模型写的变化 → 核对过的变化；对不上（ticket、feature 不存在，或者缺东西）为 null。sourceEpic 是来源 session 所在的 epic。 */
export function resolveChange(raw: RawChange, world: ActionWorld, sourceEpic: number | null): FlowChange | null {
  const t = raw.ticket ? world.ticket(raw.ticket) : null;
  if (raw.op === "close_ticket") {
    return t ? { op: "close_ticket", ticket: t.key, reason: (raw.reason ?? "").trim().slice(0, 300), closePrs: raw.closePrs } : null;
  }
  if (raw.op === "set_ticket_feature") {
    if (!t) return null;
    if (raw.feature === null) return { op: "set_ticket_feature", ticket: t.key, blockId: null };
    if (raw.feature === undefined || t.featureId === null) return null;
    const b = world.block(t.featureId, raw.feature);
    return b ? { op: "set_ticket_feature", ticket: t.key, blockId: b.id } : null;
  }
  if (raw.feature === null || raw.feature === undefined) return null;
  // 只在 ticket 或来源所在的 epic 里找：找不到不去别的 epic 碰运气（会把不相干的 epic 排了序）。都没有 epic（全局总控）才全局找，名字得唯一。
  const epic = t?.featureId ?? sourceEpic;
  const b = world.block(epic, raw.feature);
  return b ? { op: "prioritize_feature", featureId: b.featureId, blockId: b.id } : null;
}

/** 同一个变化的签名：同一个变化说两遍只处理一次。 */
export function changeSignature(c: FlowChange): string {
  switch (c.op) {
    case "close_ticket":
      return `close_ticket:${c.ticket}`;
    case "set_ticket_feature":
      return `set_ticket_feature:${c.ticket}:${c.blockId ?? "none"}`;
    case "prioritize_feature":
      return `prioritize_feature:${c.featureId}:${c.blockId}`;
  }
}

/** 已经是这个状态了（agent 用工具做过了、用户自己点过了）：不用再做。 */
export function alreadyDone(c: FlowChange, world: ActionWorld): boolean {
  if (c.op === "close_ticket") return world.ticket(c.ticket)?.closed ?? false;
  if (c.op === "set_ticket_feature") return (world.ticket(c.ticket)?.blockId ?? null) === c.blockId;
  return world.blockOrder(c.featureId)[0] === c.blockId;
}

/** 执行前的状态还在不在（ticket、feature 被删了就不能执行，等确认的卡片作废）。 */
export function stillValid(c: FlowChange, world: ActionWorld): boolean {
  if (c.op === "prioritize_feature") return world.blockOrder(c.featureId).includes(c.blockId);
  const t = world.ticket(c.ticket);
  if (!t) return false;
  if (c.op === "set_ticket_feature" && c.blockId !== null) return t.featureId !== null && world.block(t.featureId, c.blockId)?.id === c.blockId;
  return true;
}

/** 引用至少这么长才算用户真的说了（太短的什么都能对上）。 */
const QUOTE_MIN = 4;

/**
 * 原话前面（同一句话里）有这些就不算用户要做：否定（「先不要关闭 BTL-12」「I don't think we should close」）、
 * 犹豫和假设（「也许」「要不要」「如果」「maybe」「instead of」）。宁可多问一次：漏掉的只是变成等你确认。
 * 中文的在规范化以后（去掉了标点空白、转了小写）的串上找；英文的按整词找（在 words() 上），「notify」里的 if、「another」里的 not 不算。
 */
const HEDGE_ZH = /(不|别|没|勿|莫|甭|也许|可能|或许|大概|考虑|是否|要不要|是不是|能不能|可不可以|如果|假如|万一|建议)/u;
const HEDGE_EN =
  /\b(dont|doesnt|didnt|shouldnt|wont|wouldnt|cant|cannot|couldnt|isnt|arent|not|never|no need|maybe|perhaps|might|instead|whether|if|should|think|wonder)\b/u;
/**
 * 原话里、原话后面（同一句）有这些也不算：条件、犹豫（「If the demo fails, close BTL-12」「关闭 BTL-12，如果演示没过的话」）。
 * 不含否定词：「不做了」「不用再管它」是取消的说法，原话里的否定动作由 NEGATED_ACTION 管。
 */
const CONDITIONAL_ZH = /(也许|可能|或许|大概|考虑|是否|要不要|是不是|能不能|可不可以|如果|假如|万一|要是|的话|建议)/u;
const CONDITIONAL_EN = /\b(maybe|perhaps|might|instead|whether|if|unless|should|think|wonder)\b/u;
/** 英文按词比：转小写、去掉撇号（don't → dont），别的标点都当空格，空白压成一个。 */
const words = (s: string): string => ` ${s.toLowerCase().replace(/['’]/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
/** 句子：按句号、问号、分号、换行断开（逗号不断：「如果演示没过，就关掉 BTL-12」是一句），每段带着结尾的标点（看是不是问句）。 */
const SENTENCE = /[^。！？!?；;\n]+[。！？!?；;\n]?/gu;
/** 问句：「关掉 BTL-12 吗？」 */
const QUESTION = /[？?]|吗|么$/u;
/** 原话里否定词紧跟着动作（「不要关闭 BTL-12」「别挪」）。「不做了」本身就是关 ticket 的说法，不能光看有没有「不」。英文按整词。 */
const NEGATED_ACTION_ZH = /(不|别|不要|不用|不必|没|勿)(关|取消|移|换|挪|放|排|改|先做)/u;
const NEGATED_ACTION_EN = /\b(dont|do not|not|never)\s+(close|cancel|move|drop|switch|priori\w*)/u;

/**
 * 能不能不问用户直接执行：开关开着；是用户亲口说的（fromUser：用户在终端里打的一轮，不是总控派的任务、不是信箱送进来的后台轮）；
 * 模型给的原话在用户的某句话里找得到，那句话不是问句、原话前面没有否定和犹豫的词、原话和它后面没有条件和犹豫的词、
 * 原话里也没有「不要关」这类否定的动作；
 * 置信度够高；关 ticket 不连带关 PR（关 PR 是对外动作，撤销不了，一律问）。
 */
export function autoEligible(a: {
  enabled: boolean;
  change: FlowChange;
  speaker: FlowSpeaker;
  fromUser: boolean;
  quote: string;
  userText: string;
  confidence: number;
}): boolean {
  if (!a.enabled || a.speaker !== "user" || !a.fromUser || a.confidence < FLOW_AUTO_CONFIDENCE) return false;
  if (a.change.op === "close_ticket" && a.change.closePrs) return false;
  const q = normalizeFact(a.quote);
  const qw = words(maskSecrets(a.quote)).trim();
  if ([...q].length < QUOTE_MIN || NEGATED_ACTION_ZH.test(q) || NEGATED_ACTION_EN.test(qw)) return false;
  // 原话要整个落在用户的某句话里；它出现的每句话都不能是问句，同一句里原话前面不能有否定、犹豫的词，
  // 原话本身和后面不能有条件、犹豫的词（出现两次、一次被否定的也不算）。
  let found = false;
  // 原话抽出来时密钥已经打了码：用户的话也打一样的码再找。
  for (const m of maskSecrets(a.userText).matchAll(SENTENCE)) {
    const c = normalizeFact(m[0]);
    let at = c.indexOf(q);
    if (at < 0) continue;
    found = true;
    if (QUESTION.test(m[0].trim())) return false;
    while (at >= 0) {
      if (HEDGE_ZH.test(c.slice(0, at)) || CONDITIONAL_ZH.test(c.slice(at))) return false;
      at = c.indexOf(q, at + 1);
    }
    // 英文的按词：原话在这句里按词找得到就只看它前面 / 它和后面；找不到（原话跨了标点之类）就整句都不能有。
    const w = words(m[0]);
    let wa = qw ? w.indexOf(` ${qw} `) : -1;
    if (wa < 0) {
      if (HEDGE_EN.test(w) || CONDITIONAL_EN.test(w)) return false;
    }
    while (wa >= 0) {
      if (HEDGE_EN.test(w.slice(0, wa + 1)) || CONDITIONAL_EN.test(w.slice(wa))) return false;
      wa = w.indexOf(` ${qw} `, wa + 1);
    }
  }
  return found;
}

/** 撤销用的旧状态：执行前按现状算（先存下来再动手，执行到一半退出了也撤得回去）。 */
export function undoFor(c: FlowChange, world: ActionWorld): FlowUndo {
  if (c.op === "close_ticket") return { op: "reopen_ticket", ticket: c.ticket };
  if (c.op === "set_ticket_feature") return { op: "set_ticket_feature", ticket: c.ticket, blockId: world.ticket(c.ticket)?.blockId ?? null };
  return { op: "reorder_features", featureId: c.featureId, order: world.blockOrder(c.featureId) };
}

/**
 * 执行，返回做成了但有要提醒的（关了 ticket、有 PR 没关上）。调用前先查 alreadyDone / stillValid，撤销用的旧状态先用 undoFor 算好存下。
 * fallbackReason：模型没给关 ticket 的原因时用（closeTicket 要求原因非空）。
 */
export async function applyChange(c: FlowChange, world: ActionWorld, act: TicketActions, fallbackReason: string): Promise<CloseStep> {
  const done: CloseStep = { kind: "done" };
  // 原因会作为关 PR 的评论公开发到 GitHub：再打一遍码（这一版以前存下的、模型给的）。
  if (c.op === "close_ticket") return act.closeTicket(c.ticket, maskSecrets(c.reason).trim() || fallbackReason, c.closePrs, c.closePrs ? c.prUrls : undefined);
  if (c.op === "set_ticket_feature") {
    act.setBlock(c.ticket, c.blockId);
    return done;
  }
  const order = world.blockOrder(c.featureId);
  act.reorderBlocks(c.featureId, [c.blockId, ...order.filter((id) => id !== c.blockId)]);
  return done;
}

/**
 * 撤销。只在执行的结果还在时撤（alreadyDone 仍然成立）：之后用户自己又改了（ticket 挪走了、feature 重新排了、ticket 又打开了），
 * 撤销会把用户的改动盖掉，调用方就不撤。排序撤销时只排还在的 feature，新加的接在后面。
 */
export async function undoChange(u: FlowUndo, world: ActionWorld, act: TicketActions): Promise<void> {
  if (u.op === "reopen_ticket") return act.reopenTicket(u.ticket);
  if (u.op === "set_ticket_feature") return act.setBlock(u.ticket, u.blockId);
  const now = world.blockOrder(u.featureId);
  act.reorderBlocks(u.featureId, [...u.order.filter((id) => now.includes(id)), ...now.filter((id) => !u.order.includes(id))]);
}

/** 存进库里的 JSON 读回来；认不出为 null。 */
export function parseChange(json: string): FlowChange | null {
  try {
    const v = JSON.parse(json) as Partial<FlowChange> & Record<string, unknown>;
    if (v.op === "close_ticket" && typeof v.ticket === "string") {
      const c: FlowChange = { op: v.op, ticket: v.ticket, reason: String(v.reason ?? ""), closePrs: v.closePrs === true };
      if (c.closePrs && Array.isArray(v.prUrls)) c.prUrls = v.prUrls.filter((u): u is string => typeof u === "string");
      if (c.closePrs && Array.isArray(v.unclosable)) {
        c.unclosable = v.unclosable.flatMap((u: unknown) => {
          const o = u as { url?: unknown; error?: unknown } | null;
          return o && typeof o.url === "string" ? [{ url: o.url, error: String(o.error ?? "") }] : [];
        });
      }
      return c;
    }
    if (v.op === "set_ticket_feature" && typeof v.ticket === "string" && (v.blockId === null || typeof v.blockId === "number")) return { op: v.op, ticket: v.ticket, blockId: v.blockId };
    if (v.op === "prioritize_feature" && typeof v.featureId === "number" && typeof v.blockId === "number") return { op: v.op, featureId: v.featureId, blockId: v.blockId };
  } catch {
    /* 坏了 */
  }
  return null;
}

export function parseUndo(json: string | null): FlowUndo | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (v.op === "reopen_ticket" && typeof v.ticket === "string") return { op: v.op, ticket: v.ticket };
    if (v.op === "set_ticket_feature" && typeof v.ticket === "string" && (v.blockId === null || typeof v.blockId === "number")) return { op: v.op, ticket: v.ticket, blockId: v.blockId };
    if (v.op === "reorder_features" && typeof v.featureId === "number" && Array.isArray(v.order) && v.order.every((x) => typeof x === "number")) {
      return { op: v.op, featureId: v.featureId, order: v.order as number[] };
    }
  } catch {
    /* 坏了 */
  }
  return null;
}
