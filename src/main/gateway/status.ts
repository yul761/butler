import type { AuditEntry, AuditPage, LlmStatus } from "../../shared/llm";
import type { AuditRepo } from "../db/audit-repo";
import type { SettingsRepo } from "../db/settings-repo";
import { isLoopbackHost, llmConfig, priceFor } from "../settings/settings-values";
import { monthStart } from "./budget";
import type { KeyStore } from "./key-store";
import { scrub, scrubKey } from "./provider";

/** 审计页每页的条数。 */
export const AUDIT_PAGE_SIZE = 50;

/** 设置页顶部的状态：key 的打码形式、是否配置完、模型有没有价格、本月花费。不含 key 本身。 */
export function llmStatus(d: { settings: SettingsRepo; keys: Pick<KeyStore, "state">; audit: Pick<AuditRepo, "costSince">; now: () => number }): LlmStatus {
  const cfg = llmConfig(d.settings);
  const key = d.keys.state();
  const local = cfg.baseUrl !== "" && isLoopbackHost(new URL(cfg.baseUrl).hostname);
  return {
    ...key,
    configured: cfg.level !== "off" && cfg.baseUrl !== "" && cfg.model !== "" && (local || (key.keySaved && !key.keyUnreadable)),
    priceKnown: cfg.model !== "" && priceFor(cfg.prices, cfg.model) !== null,
    monthCostUsd: d.audit.costSince(monthStart(d.now())),
    budgetUsd: cfg.budgetUsd,
  };
}

const scrubField = (text: string | null, key: string | null): string | null => (text === null ? null : scrub(text, key));

/**
 * 审计页（新的在前，beforeId 翻页）。纵深防御：gateway 从不把 key 写进审计，
 * 这里返回给渲染进程之前仍把保存的 key 从文本字段里去掉；响应和报错另外去掉 Bearer 凭证。
 * 请求体只去 key 本身：它要原样展示发出去的内容，内容里提到 "Bearer xxx" 不能被改写。
 */
export function auditPage(
  d: { settings: SettingsRepo; keys: Pick<KeyStore, "get" | "state">; audit: Pick<AuditRepo, "list" | "costSince">; now: () => number },
  beforeId?: number,
): AuditPage {
  const rows = d.audit.list(AUDIT_PAGE_SIZE + 1, beforeId);
  // state() 有缓存：没保存或已知解不开时不再去碰钥匙串（也不会每翻一页记一次日志）。
  const st = d.keys.state();
  const key = st.keySaved && !st.keyUnreadable ? d.keys.get() : null;
  const entries = rows.slice(0, AUDIT_PAGE_SIZE).map(
    (e): AuditEntry => ({ ...e, payloadSent: e.payloadSent === null ? null : scrubKey(e.payloadSent, key), response: scrubField(e.response, key), error: scrubField(e.error, key) }),
  );
  return {
    entries,
    hasMore: rows.length > AUDIT_PAGE_SIZE,
    monthCostUsd: d.audit.costSince(monthStart(d.now())),
    budgetUsd: llmConfig(d.settings).budgetUsd,
  };
}
