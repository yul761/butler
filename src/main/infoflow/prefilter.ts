import type { TurnKind } from "../db/conv-repo";

/**
 * 信息流转（BTL-272）的规则预筛：不花钱，先挡掉明显没什么要传的轮，剩下的才问模型。
 *
 * - handoff（写交接）、fork（分叉讨论）的轮不看：交接本来就进记忆，分叉讨论的结论另有去处。
 * - silent 的轮（斜杠命令、Shipherd 的通知、信箱直接输入、转达的回答）：对话记录里只存了转达的用户回答（那是用户的原话，要看），
 *   别的粘进去的东西本来就没存。回应别人发来的要点时只记不发，由 InfoflowService 按这一轮有没有收到 fact 判断，免得兜圈子。
 * - 双方加起来太短的不看（「好的」「收到」）。
 * - 没有决定类的词（改成、不做了、以后一律、must、from now on……）的不看。
 */

/** 双方加起来不到这么多字符：太短，跳过。 */
export const FLOW_MIN_CHARS = 16;
/** 交给模型的用户原话最多这么多字符（取开头）。 */
export const FLOW_USER_CHARS = 3000;
/** 交给模型的 agent 原话最多这么多字符（取结尾：结论一般在最后）。 */
export const FLOW_AGENT_CHARS = 3000;

// 只认表示「定下来了、变了、以后都这样」的说法。写代码时天天出现的词（接口、字段、版本、合并、依赖、注意；api、merge、always、
// first、later、interface、schema、release）不算：它们几乎每一轮都有，留着等于每轮都问模型。
const ZH = /决定|定了|定下|就这么定|改成|改为|改用|换成|挪到|移到|归到|不做了|不用做|别做|先不做|先做|优先|往后放|推迟|延后|关掉|关闭|取消|撤掉|放弃|废弃|不要了|不需要了|需求变|以后都|以后一律|今后|往后都|从现在起|从现在开始|一律|统一用|统一成|必须|务必|不许|禁止|别再|约定|规定|规矩|原则|记住|改名|重命名|拆成|阻塞|卡在|等.{0,6}(合|完|好)再/;
const EN = /\b(decided|decision|agreed|let'?s go with|switch(ed)? to|instead of|from now on|going forward|must(n'?t)? |never (use|commit|push|merge|deploy|ship|touch|edit|change|delete|add|call|run|skip)|no longer|stop doing|cancel(l?ed)?|close (it|this|the|btl|[a-z]+-\d)|drop(ped)? (it|this|the)|abandon|deprecat|prioriti[sz]e|postpone|defer|move .{1,40} to|rename|convention|constraint|block(ed|s)? (on|by)|depends? on)/i;

export function hasDecisionWords(text: string): boolean {
  const t = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/\bhttps?:\/\/\S+/gi, " ");
  return ZH.test(t) || EN.test(t);
}

const head = (s: string, n: number): string => {
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(0, n).join("");
};
const tail = (s: string, n: number): string => {
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(-n).join("");
};

export type PrefilterResult =
  | { ok: true; userText: string; agentText: string }
  | { ok: false; reason: "kind" | "short" | "no_signal" };

/** 一轮过不过预筛；过了的同时给出截好的双方原话（用户取开头、agent 取结尾）。 */
export function prefilterTurn(t: { kind: TurnKind; userText: string; agentText: string }): PrefilterResult {
  if (t.kind === "handoff" || t.kind === "fork") return { ok: false, reason: "kind" };
  const userText = t.userText.trim();
  const agentText = t.agentText.trim();
  if ([...userText].length + [...agentText].length < FLOW_MIN_CHARS) return { ok: false, reason: "short" };
  if (!hasDecisionWords(userText) && !hasDecisionWords(agentText)) return { ok: false, reason: "no_signal" };
  return { ok: true, userText: head(userText, FLOW_USER_CHARS), agentText: tail(agentText, FLOW_AGENT_CHARS) };
}
