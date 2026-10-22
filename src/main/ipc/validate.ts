import type { SensitiveTerm } from "../../shared/llm";
import { normalizeTerms, SettingError, TERMS_LIMIT } from "../settings/settings-values";

/**
 * 渲染进程不可信：IPC 参数在主进程里按运行时类型检查，不合规就抛错（toIpcResult 包装成 { ok: false }）。
 * 上限在做任何规范化之前生效，超大的输入不会被逐项处理。
 */

/** key 本身的格式（8–512 个可打印 ASCII）由 KeyStore 检查；这里只挡住非字符串和超大的输入。 */
const API_KEY_INPUT_LIMIT = 4096;
/** 提交的条数上限：去重前可以比 TERMS_LIMIT 多一些（normalizeTerms 再按去重后的条数限制）。 */
export const TERMS_INPUT_LIMIT = TERMS_LIMIT * 2;
/** 单个敏感词原文的上限（NFKC 和压缩空白之前）；规范化后的上限是 100 字，由 normalizeTerms 检查。 */
const TERM_INPUT_LENGTH = 1000;

export function apiKeyArg(v: unknown): string {
  // 报错里不带输入：它可能就是 key。
  if (typeof v !== "string" || v.length > API_KEY_INPUT_LIMIT) throw new SettingError("API key 格式不对");
  return v;
}

export function termsArg(v: unknown): SensitiveTerm[] {
  if (!Array.isArray(v)) throw new SettingError("敏感词表格式不对");
  if (v.length > TERMS_INPUT_LIMIT) throw new SettingError(`敏感词最多 ${TERMS_LIMIT} 个`);
  for (const x of v as unknown[]) {
    const o = x as { term?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.term !== "string") throw new SettingError("敏感词表格式不对");
    if (o.term.length > TERM_INPUT_LENGTH) throw new SettingError("敏感词太长（上限 100 字）");
  }
  return normalizeTerms(v);
}

/** 审计翻页的游标：不传，或者正整数（上一页最后一条的 id）。 */
export function auditCursorArg(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
  throw new Error(`invalid audit cursor: ${typeof v}`);
}

/** ticket 号：1–200 字的字符串（格式由 ticket 正则决定；查不到就是空结果）。 */
export function ticketKeyArg(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new Error("invalid ticket key");
  return v;
}

/** StateCore 的事实 / 交接 id（UUID）。 */
export function factIdArg(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(v)) throw new Error("invalid memory id");
  return v;
}
