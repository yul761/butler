import { z } from "zod";
import type { ActivityKind } from "../../shared/activity";
import { headlessArgs } from "../claude/headless";
import { execHeadlessJson, type HeadlessExecDeps } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import { currentLang } from "../i18n";
import { sanitizeJudgeReason } from "../util/judge-text";

/** 给判断看的最后一条回复最多多少个字符（取结尾）。 */
export const NEEDS_YOU_REPLY_CHARS = 1500;
/** 退路的理由（最后一句）最多多少个字符。 */
const FALLBACK_REASON_CHARS = 80;
/** 同时最多几个判断。 */
const MAX_JUDGES = 2;

const AnswerSchema = z.object({ needs_user: z.boolean(), reason: z.string() });
const NEEDS_YOU_JSON_SCHEMA = toCliJsonSchema(AnswerSchema);

export interface NeedsYouVerdict {
  needsYou: boolean;
  reason: string;
}

/** 按字符（不切开代理对）取结尾。 */
function tail(text: string, chars: number): string {
  const all = [...text];
  return all.length <= chars ? text : all.slice(-chars).join("");
}

function prompt(reply: string): string {
  if (currentLang() === "en") {
    return [
      "Below is the last message a coding Claude session showed the user when it stopped.",
      "Decide: is it waiting for the user to answer a question, make a decision, or go do something before it can continue?",
      'Merely reporting progress or results, saying "done", or saying "waiting for CI" does not count.',
      "Answer as JSON: needs_user (boolean), reason (one sentence in English on what it is waiting for from the user, at most 15 words; leave empty if not needed).",
      "",
      "Message:",
      reply,
    ].join("\n");
  }
  return [
    "下面是一个写代码的 Claude session 停下来时给用户看的最后一条消息。",
    "判断：它是不是在等用户回答问题、做决定、或者去做某件事之后才能继续？",
    '单纯汇报进度或结果、说"做完了"、说"在等 CI"，都不算。',
    "用 JSON 回答：needs_user（布尔），reason（一句话，说它在等用户什么，不超过 30 个字；不需要就留空）。",
    "",
    "消息：",
    reply,
  ].join("\n");
}

/** 请 Haiku 判断一条回复是不是在等用户。不给任何工具，只看回复的最后 1500 字；失败返回 null。 */
export async function judgeNeedsYou(d: HeadlessExecDeps, reply: string, cwd: string): Promise<NeedsYouVerdict | null> {
  const args = headlessArgs({ schema: NEEDS_YOU_JSON_SCHEMA, allowedTools: [], model: "haiku" });
  const r = await execHeadlessJson(d, { label: "needs-you judge", args, prompt: prompt(tail(reply, NEEDS_YOU_REPLY_CHARS)), cwd });
  if (!r.ok) return null;
  const v = validate(AnswerSchema, r.value);
  // 理由会显示在「现在」页上：去掉混进来的标签，压成一行，最多 80 字（R34）。
  return v.ok ? { needsYou: v.value.needs_user, reason: sanitizeJudgeReason(v.value.reason) } : null;
}

/** 回复末尾包着问句的东西：空白、Markdown 的强调和代码标记、右括号、右引号。 */
const TRAILING_WRAPPERS_RE = /[\s*_`)）」』"”']+$/;

/** 去掉末尾的包装：“**要拆吗？**”的结尾其实是问号。 */
const unwrapEnd = (text: string): string => text.replace(TRAILING_WRAPPERS_RE, "");

/** 最后一句（连同句末的标点，不带末尾的包装），最多 80 字，取结尾。 */
function lastSentence(text: string): string {
  const t = unwrapEnd(text);
  // 先把句末的标点放到一边，再找它前面的最后一个句子边界：中文句末标点、换行，或者后面跟空白的英文标点。
  const body = t.slice(0, t.length - (/[。！？.!?]*$/.exec(t)?.[0].length ?? 0));
  let start = 0;
  for (const m of body.matchAll(/[。！？\n]|[.!?](?=\s)/g)) start = m.index + 1;
  // 句首的强调和代码标记也去掉，免得理由里留半截 Markdown。
  return tail(t.slice(start).replace(/^[\s*_`]+/, ""), FALLBACK_REASON_CHARS);
}

/** 判断失败时的退路。 */
export function fallbackNeedsYou(reply: string): NeedsYouVerdict {
  return /[?？]$/.test(unwrapEnd(reply)) ? { needsYou: true, reason: lastSentence(reply) } : { needsYou: false, reason: "" };
}

export interface NeedsYouHead {
  id: string;
  cwd: string;
  waiting: boolean;
  kind: ActivityKind | null;
  reply: { id: string; text: string } | null;
}

export interface NeedsYouDeps {
  judge: (reply: string, cwd: string) => Promise<NeedsYouVerdict | null>;
  /** 开着终端的 Butler session 的 head：id、cwd、是否停着等输入、活动、最后一条回复。 */
  sessions: () => NeedsYouHead[];
  notify: () => void;
  log?: (msg: string, err?: unknown) => void;
}

interface Entry {
  replyId: string;
  /** null：还在排队或者在判断。 */
  verdict: NeedsYouVerdict | null;
  /** 停在这条回复上之后又忙起来过（用户回答了）：之后哪怕又停在同一条回复上，也不再算需要你。 */
  answered: boolean;
}

interface Job {
  sessionId: string;
  replyId: string;
  text: string;
  cwd: string;
}

/** 停着、活动是 waiting、有最后一条回复：才可能是在等用户。 */
const stoppedReply = (s: NeedsYouHead): { id: string; text: string } | null => (s.waiting && s.kind === "waiting" ? s.reply : null);

/**
 * “需要你”：每个 session 只记最后一条回复的结论，按 message.id 每条只判断一次（失败也记下退路的结论，不再重判）。
 * 全部只存内存。
 */
export class NeedsYouTracker {
  private readonly entries = new Map<string, Entry>();
  /** 等名额的判断，键是 session id：同一个 session 有了新回复就顶掉排着的旧的。 */
  private readonly queue = new Map<string, Job>();
  private running = 0;
  /** suppressNext 记下的 session 和当时它最后一条回复的 id（没有为 null）：之后第一条不同的回复不判断，直接记成不需要你。 */
  private readonly skips = new Map<string, string | null>();

  constructor(private readonly d: NeedsYouDeps) {}

  /**
   * 这个 session（head 的 id）的下一条新回复不判断，直接记成不需要你（R35）：Butler 换新后输入的「接着做」那句话，
   * 它的回复只是说做到哪了、等用户的指令，不是在问用户。只跳过一条；session 不在了就作废。
   */
  suppressNext(sessionId: string): void {
    const s = this.d.sessions().find((x) => x.id === sessionId);
    this.skips.set(sessionId, s?.reply?.id ?? this.entries.get(sessionId)?.replyId ?? null);
  }

  /** 每个活动 tick 之后调：停着、活动是 waiting、回复 id 没判断过的，排队判断（最多 2 个同时）。 */
  update(): void {
    const heads = this.d.sessions();
    const live = new Set(heads.map((s) => s.id));
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);
    for (const id of this.queue.keys()) if (!live.has(id)) this.queue.delete(id);
    for (const id of this.skips.keys()) if (!live.has(id)) this.skips.delete(id);
    for (const s of heads) {
      const reply = stoppedReply(s);
      const e = this.entries.get(s.id);
      if (!reply) {
        // 只有先停在这条回复上、现在又忙起来，才算回答过。没停过的回复不算：transcript 已经写完、“停着”还没跟上时，
        // 最后那条回复看起来也是忙着的，记成回答过就永远判断不到它了。
        if (e && s.reply && e.replyId === s.reply.id) this.markAnswered(s.id, e);
        continue;
      }
      if (e?.replyId === reply.id) continue;
      if (this.skips.has(s.id) && this.skips.get(s.id) !== reply.id) {
        this.skips.delete(s.id);
        this.queue.delete(s.id);
        this.entries.set(s.id, { replyId: reply.id, verdict: { needsYou: false, reason: "" }, answered: false });
        continue;
      }
      this.entries.set(s.id, { replyId: reply.id, verdict: null, answered: false });
      this.queue.set(s.id, { sessionId: s.id, replyId: reply.id, text: tail(reply.text, NEEDS_YOU_REPLY_CHARS), cwd: s.cwd });
    }
    this.pump();
  }

  /** 需要你时返回理由，否则 null。session 不再停着（或活动不是 waiting）时立刻返回 null。 */
  reasonOf(sessionId: string): string | null {
    const s = this.d.sessions().find((x) => x.id === sessionId);
    return s ? this.reasonFor(s) : null;
  }

  /**
   * 停在一条回复上、还没有结论（没排上、排着队或者正在判断）。自动换新等它判断完再说（计划 16）：
   * 刚停下来问了用户问题的 session，结论出来之前 reasonOf 是 null，不能当作不需要你。
   */
  undecided(sessionId: string): boolean {
    const s = this.d.sessions().find((x) => x.id === sessionId);
    const reply = s ? stoppedReply(s) : null;
    if (!reply) return false;
    const e = this.entries.get(sessionId);
    return !e || e.replyId !== reply.id || (e.verdict === null && !e.answered);
  }

  /** 所有需要你的 session 和理由：只列一遍 session（「现在」页每次取一整份，不用每行都调 reasonOf）。 */
  reasons(): Map<string, string> {
    const out = new Map<string, string>();
    for (const s of this.d.sessions()) {
      const r = this.reasonFor(s);
      if (r !== null) out.set(s.id, r);
    }
    return out;
  }

  private reasonFor(s: NeedsYouHead): string | null {
    const reply = stoppedReply(s);
    const e = this.entries.get(s.id);
    if (!reply || e?.replyId !== reply.id || e.answered || !e.verdict?.needsYou) return null;
    // 模型说需要却没给理由：用最后一句代替，界面上不能是空的。
    return e.verdict.reason.trim() || lastSentence(reply.text);
  }

  /** 回答过的回复不用再判断：还在排队的撤掉。 */
  private markAnswered(sessionId: string, e: Entry): void {
    e.answered = true;
    if (this.queue.get(sessionId)?.replyId === e.replyId) this.queue.delete(sessionId);
  }

  /** 有名额就开始排着的判断；判断要几秒到几十秒，不等它。 */
  private pump(): void {
    for (const [id, job] of this.queue) {
      if (this.running >= MAX_JUDGES) return;
      this.queue.delete(id);
      this.running++;
      void this.judge(job);
    }
  }

  private async judge(job: Job): Promise<void> {
    let verdict: NeedsYouVerdict | null = null;
    try {
      verdict = await this.d.judge(job.text, job.cwd);
    } catch (e) {
      this.d.log?.(`needs-you judge of session ${job.sessionId} failed`, e);
    } finally {
      this.running--;
    }
    const e = this.entries.get(job.sessionId);
    // 判断期间有了新回复或者终端关了：这个结论已经无关。
    if (e?.replyId === job.replyId) {
      e.verdict = verdict ?? fallbackNeedsYou(job.text);
      if (e.verdict.needsYou && !e.answered) this.d.notify();
    }
    this.pump();
  }
}

/**
 * 递 CI 结果、合并通知那道 guard 的「需要你」（I1）：真判断出需要你挡；停在一条还没判断完的回复上也挡——Stop 的那一刻新回复的
 * 判断还在排队，这时贴进去，可能正好贴在一个问了用户问题的 session 里。判断说不需要之后，下一次 flush（PrWatcher 每轮的 roundDone、
 * HoldWatcher 的定时检查）再递。
 */
export function deliveryNeedsYou(t: Pick<NeedsYouTracker, "reasonOf" | "undecided">, sessionId: string): boolean {
  return t.reasonOf(sessionId) !== null || t.undecided(sessionId);
}
