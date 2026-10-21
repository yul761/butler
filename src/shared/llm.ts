/** 个人 LLM API（设计文档第 7 节）的共享类型。 */

export const PRIVACY_LEVELS = ["off", "metadata", "redacted", "full"] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export const TERM_CATEGORIES = ["person", "term"] as const;
export type TermCategory = (typeof TERM_CATEGORIES)[number];
export interface SensitiveTerm {
  term: string;
  /** person：人名；term：项目代号、客户名等其他敏感词。 */
  category: TermCategory;
}

/** pending：已写审计、还没发完；sent：发出去了（不管响应能不能用）；failed：发送失败；blocked：扫描命中被拒发；budget：超预算或没有价格，没发；declined：用户拒绝了发送前确认。 */
export const AUDIT_STATUSES = ["pending", "sent", "failed", "blocked", "budget", "declined"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const SCAN_RULES = ["secret", "url", "domain", "ip", "email", "path", "ticket", "known"] as const;
export type ScanRule = (typeof SCAN_RULES)[number];
export interface ScanHit {
  rule: ScanRule;
  /** 打码后的样本：前 3 个字符 + 长度。 */
  sample: string;
}

export interface AuditEntry {
  id: number;
  ts: number;
  /** base URL 的 host。 */
  provider: string;
  model: string;
  level: PrivacyLevel;
  status: AuditStatus;
  /** 原样发出的请求体；没有发出（拒发、超预算）时为 null。 */
  payloadSent: string | null;
  /** 服务商原样返回的响应体（占位符没有还原）。 */
  response: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  blockedReason: ScanHit[] | null;
  error: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  hasMore: boolean;
  monthCostUsd: number;
  budgetUsd: number;
}

export interface KeyState {
  keySaved: boolean;
  /** 打码后的 key，例如 ••••3f9a。完整的 key 永远不会到渲染进程。 */
  keyMasked: string | null;
  /** 保存过但现在解不开（钥匙串被重置、换了电脑）：需要重新输入。 */
  keyUnreadable: boolean;
  /** 系统的加密存储可用（macOS 钥匙串 / Windows DPAPI）。 */
  encryptionAvailable: boolean;
}

export interface LlmStatus extends KeyState {
  /** 档位不是 off，base URL 和模型都填了，远程服务还有可用的 key。 */
  configured: boolean;
  /** 当前模型在价格表里有价格。没有时不会调用。 */
  priceKnown: boolean;
  monthCostUsd: number;
  budgetUsd: number;
}
