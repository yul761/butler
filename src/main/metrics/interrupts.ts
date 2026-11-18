import { z } from "zod";
import { INTERRUPT_CATEGORIES, type InterruptCategory } from "../../shared/metrics";
import { headlessArgs } from "../claude/headless";
import { execHeadlessJson, type HeadlessExecDeps } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import { currentLang } from "../i18n";
import { toCategory } from "../sessions/needs-you";
import type { RecordEvent } from "./events";

/** 给分类看的问题最多多少个字符（取开头）。 */
const QUESTION_CHARS = 1200;

const ClassifySchema = z.object({ category: z.string() });
const CLASSIFY_JSON_SCHEMA = toCliJsonSchema(ClassifySchema);

function classifyPrompt(question: string, context: string | null): string {
  const text = [question, context ?? ""].join("\n").slice(0, QUESTION_CHARS);
  if (currentLang() === "en") {
    return [
      "A coding Claude session asked the user the question below. Which kind of interruption is it?",
      "permission = asking to be allowed to do something; choice = pick between approaches or options; " +
        "missing_info = it lacks a fact, file, access or credential only the user has; question = a real open question that needs the user's judgement; " +
        "stuck = it tried and cannot get past an error or blocker.",
      `Answer as JSON: category (one of ${INTERRUPT_CATEGORIES.join(", ")}).`,
      "",
      "Question:",
      text,
    ].join("\n");
  }
  return [
    "一个写代码的 Claude session 问了用户下面这个问题。它属于哪一类打断？",
    "permission = 请用户允许它做某件事；choice = 在几个方案或选项里选一个；missing_info = 缺一个只有用户有的信息、文件、权限或凭据；" +
      "question = 需要用户拿主意的真问题；stuck = 试过了，被报错或障碍卡住过不去。",
    `用 JSON 回答：category（${INTERRUPT_CATEGORIES.join("、")} 之一）。`,
    "",
    "问题：",
    text,
  ].join("\n");
}

/** ask_user 没给两个以上选项时，请路由里的低档模型（task needs_you）分一下类；失败返回 null。 */
export async function classifyQuestion(d: HeadlessExecDeps, question: string, context: string | null, cwd: string): Promise<InterruptCategory | null> {
  const args = headlessArgs({ schema: CLASSIFY_JSON_SCHEMA, allowedTools: [] });
  const r = await execHeadlessJson(d, { task: "needs_you", label: "interrupt classify", args, prompt: classifyPrompt(question, context), cwd });
  if (!r.ok) return null;
  const v = validate(ClassifySchema, r.value);
  return v.ok ? toCategory(v.value.category) : null;
}

export interface AskedForMetrics {
  id: number;
  sessionId: string;
  ticketKey: string | null;
  question: string;
  options: string[];
  context: string | null;
  /** 被这条顶掉的、同一个问题的旧条目：又问了一遍，沿用旧条目的类别，不另记打断、不再调模型。 */
  supersedes?: readonly number[];
}

export interface InterruptDeps {
  record: RecordEvent;
  /** 没有选项的 ask_user 怎么分类（路由里的模型）；null 记成 question。 */
  classify(q: AskedForMetrics): Promise<InterruptCategory | null>;
  /** 这个 session（head）有没有还没决的 ask_user：有的话 needs-you 不另记（「现在」页也这样去重）。 */
  hasPendingDecision(sessionId: string): boolean;
  /** session → ticket（记事件用）。 */
  ticketOf(sessionId: string): string | null;
  log?: (msg: string, err?: unknown) => void;
}

/** 有两个以上选项就是选择题，不用调模型。 */
export const deterministicAskCategory = (options: readonly string[]): InterruptCategory | null => (options.length >= 2 ? "choice" : null);

/**
 * 打断原因（7.4 的统计）：每次打断记一条 interrupt 事件，category 是五类之一。能确定的直接定，
 * 定不了的（没有选项的 ask_user）走路由（契约 4.1）。
 */
export class InterruptRecorder {
  /** ask_user 条目 id → 类别（等人时间段用）；分类出来之前没有。 */
  private readonly askCategories = new Map<number, InterruptCategory>();

  constructor(private readonly d: InterruptDeps) {}

  /** 一条新的 ask_user。返回分好的类别（测试用）。 */
  async asked(q: AskedForMetrics): Promise<InterruptCategory> {
    const again = q.supersedes && q.supersedes.length > 0;
    if (again) {
      const prior = q.supersedes?.map((id) => this.askCategories.get(id)).find((c) => c !== undefined);
      const c = prior ?? deterministicAskCategory(q.options) ?? "question";
      this.askCategories.set(q.id, c);
      return c;
    }
    let category = deterministicAskCategory(q.options);
    if (!category) {
      try {
        category = await this.d.classify(q);
      } catch (e) {
        this.d.log?.(`metrics: classifying question ${q.id} failed`, e);
      }
    }
    const c = category ?? "question";
    this.askCategories.set(q.id, c);
    this.d.record("interrupt", { sessionId: q.sessionId, ticketKey: q.ticketKey, dedupeKey: `interrupt:ask:${q.id}`, data: { category: c, source: "ask_user" } });
    return c;
  }

  /** ask_user 条目的类别；还没分出来时为 null。 */
  askCategory(itemId: number): InterruptCategory | null {
    return this.askCategories.get(itemId) ?? null;
  }

  /** needs-you 判断说这条回复在等用户。 */
  needsYou(sessionId: string, replyId: string, category: InterruptCategory): boolean {
    if (this.d.hasPendingDecision(sessionId)) return false;
    return this.d.record("interrupt", {
      sessionId, ticketKey: this.d.ticketOf(sessionId), dedupeKey: `interrupt:needs_you:${sessionId}:${replyId}`, data: { category, source: "needs_you" },
    });
  }

  /** activity-monitor 判断一个 session 新卡住了（每次卡住只调一次）。 */
  stuck(sessionId: string, ticketKey: string | null): boolean {
    return this.d.record("interrupt", { sessionId, ticketKey, data: { category: "stuck", source: "stuck" } });
  }

  /** WaitTracker 开了一个权限确认 / AskUserQuestion 的等待段。 */
  spanOpened(spanId: number, sessionId: string, ticketKey: string | null, category: InterruptCategory, source: string): boolean {
    return this.d.record("interrupt", { sessionId, ticketKey, dedupeKey: `interrupt:span:${spanId}`, data: { category, source } });
  }

  /** 只留还没结束的条目的类别（每次 sync 传进来；结束了的不用留着）。 */
  retainAsks(pending: ReadonlySet<number>): void {
    for (const id of this.askCategories.keys()) if (!pending.has(id)) this.askCategories.delete(id);
  }
}
