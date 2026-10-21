import type { AuditEntry, AuditStatus, ScanHit } from "../../shared/llm";
import { formatUsd } from "./privacy-form";
import { S } from "./strings";

export function auditStatusLabel(s: AuditStatus): string {
  return S.auditStatus[s] ?? s;
}

/** 拦截原因：规则名（打码样本）。 */
export function blockedText(hits: ScanHit[] | null): string {
  return (hits ?? []).map((h) => `${S.scanRule[h.rule] ?? h.rule}（${h.sample}）`).join(S.listSep);
}

/** 列表里每一行的摘要：档位 · 状态 · token · 费用。 */
export function auditSummary(e: AuditEntry): string {
  const parts = [S.privacyLevels[e.level], auditStatusLabel(e.status)];
  if (e.tokensIn !== null || e.tokensOut !== null) parts.push(S.auditTokens(e.tokensIn ?? 0, e.tokensOut ?? 0));
  if (e.costUsd !== null) parts.push(formatUsd(e.costUsd));
  return parts.join(" · ");
}

/** 单遍解析、单遍输出；任何异常都退回原文，永不抛出。 */
export function prettyJson(text: string | null): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 只在这两种开头时才尝试展开消息内容里的 JSON，避免对普通长文本白做一次解析。 */
const looksLikeJson = (s: string) => /^\s*[{[]/.test(s);

/** 请求体排版成多行；消息里的 JSON 字符串（出站数据）只多展开一层，方便逐字段核对。内容不变，只是换了排版。永不抛出。 */
export function prettyBody(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const messages = (body as { messages?: unknown }).messages;
      if (Array.isArray(messages)) {
        (body as { messages: unknown[] }).messages = messages.map((m: unknown) => {
          if (!m || typeof m !== "object") return m;
          const content = (m as { content?: unknown }).content;
          if (typeof content !== "string" || !looksLikeJson(content)) return m;
          try {
            return { ...(m as object), content: JSON.parse(content) as unknown };
          } catch {
            return m;
          }
        });
      }
    }
    return JSON.stringify(body, null, 2);
  } catch {
    return text;
  }
}

/** 请求体的标题：只有确认已发送的才叫“发出的内容”；失败或未完成的可能已经发出。 */
export function bodyHeading(status: AuditStatus): string {
  return bodyMaybeSent(status) ? S.auditBodyMaybeSent : S.auditPayload;
}

/** 失败或未完成的行带着请求体时，提醒这份内容可能已经发出。 */
export function bodyMaybeSent(status: AuditStatus): boolean {
  return status === "failed" || status === "pending";
}
