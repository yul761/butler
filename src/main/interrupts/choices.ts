import type { AutoChoice, ChoiceDefault } from "../../shared/interrupts";
import type { AutoChoicesRepo, ChoiceDefaultsRepo } from "../db/interrupts-repo";
import type { RecordEvent } from "../metrics/events";
import { SettingError } from "../settings/settings-values";
import { M } from "../strings";

export const PATTERN_MAX = 200;
export const ANSWER_MAX = 500;

export interface ChoiceServiceDeps {
  choices: AutoChoicesRepo;
  defaults: ChoiceDefaultsRepo;
  setting(key: "interruptChoiceDefaults"): string;
  recordEvent?: RecordEvent;
  now(): number;
  /** 默认答案开关、规则开关打开时调：Effect 页前后对比的分界（只第一次生效）。 */
  markEffective(at: number): void;
  notify?(): void;
}

/** 一次 ask_user 里和默认答案有关的部分。 */
export interface ChoiceQuestion {
  question: string;
  options: readonly string[];
  recommended?: number;
}

/** 问题里出现 pattern 的某个关键词（| 分隔、去空白、不分大小写）。 */
export function patternMatches(pattern: string, question: string): boolean {
  const q = question.toLocaleLowerCase();
  return pattern.split("|").map((w) => w.trim().toLocaleLowerCase()).some((w) => w.length > 0 && q.includes(w));
}

/**
 * 选择（ws-j 设计 3）：session 按规则自己选了推荐项（report kind choice），或者 Butler 按用户设的默认答案替用户答了。
 * 都存进 auto_choices 等用户事后看，记一条 interrupt_auto_resolved（不算人介入）。
 */
export class ChoiceService {
  constructor(private readonly d: ChoiceServiceDeps) {}

  /** session 按规则自己做了选择。 */
  recordRule(s: { sessionId: string; ticketKey: string | null }, text: string): number {
    const at = this.d.now();
    const id = this.d.choices.add({ source: "rule", sessionId: s.sessionId, ticketKey: s.ticketKey, text, at });
    this.d.recordEvent?.("interrupt_auto_resolved", { sessionId: s.sessionId, ticketKey: s.ticketKey, at, dedupeKey: `choice:${id}`, data: { category: "choice", via: "rule" } });
    this.d.notify?.();
    return id;
  }

  /**
   * 默认答案开着、问题至少有两个选项、有一条启用的默认答案匹配：返回要送给 session 的答案（答案为空的默认答案取推荐项；没有推荐项就不答）。
   * 不匹配返回 null（照常等用户）。
   */
  match(q: ChoiceQuestion): { answer: string; defaultId: number } | null {
    if (this.d.setting("interruptChoiceDefaults").trim() !== "1" || q.options.length < 2) return null;
    for (const def of this.d.defaults.list()) {
      if (!def.enabled || !patternMatches(def.pattern, q.question)) continue;
      const answer = def.answer.trim() || (q.recommended !== undefined ? q.options[q.recommended] : undefined);
      if (answer) return { answer, defaultId: def.id };
    }
    return null;
  }

  /** Butler 按默认答案替用户答了 decisionId。 */
  recordDefault(s: { sessionId: string; ticketKey: string | null }, decisionId: number, defaultId: number, question: string, answer: string): number {
    const at = this.d.now();
    const id = this.d.choices.add({ source: "default", sessionId: s.sessionId, ticketKey: s.ticketKey, decisionId, defaultId, text: M().interrupts.autoChoiceDefault(question, answer), at });
    this.d.recordEvent?.("interrupt_auto_resolved", { sessionId: s.sessionId, ticketKey: s.ticketKey, at, dedupeKey: `choice-default:${decisionId}`, data: { category: "choice", via: "default" } });
    this.d.notify?.();
    return id;
  }

  list(): AutoChoice[] {
    return this.d.choices.list();
  }

  unreviewed(): number {
    return this.d.choices.unreviewed();
  }

  review(ids: readonly number[] | null): number {
    const n = this.d.choices.review(ids, this.d.now());
    if (n > 0) this.d.notify?.();
    return n;
  }

  defaults(): ChoiceDefault[] {
    return this.d.defaults.list();
  }

  saveDefault(x: { id: number | null; pattern: string; answer: string; enabled: boolean }): ChoiceDefault[] {
    const pattern = x.pattern.trim();
    if (!pattern || pattern.length > PATTERN_MAX || pattern.split("|").every((w) => !w.trim())) throw new SettingError(M().interrupts.badPattern);
    if (x.answer.length > ANSWER_MAX) throw new SettingError(M().interrupts.badAnswer);
    this.d.defaults.save({ id: x.id, pattern, answer: x.answer.trim(), enabled: x.enabled, at: this.d.now() });
    return this.d.defaults.list();
  }

  deleteDefault(id: number): ChoiceDefault[] {
    this.d.defaults.delete(id);
    return this.d.defaults.list();
  }
}
