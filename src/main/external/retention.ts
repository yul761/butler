const DAY_MS = 86_400_000;

/**
 * 对外动作审计（和外部通知记录）的保留期起点：早于它的记录清掉。
 * BTL-243 之前还要留住本月的记录（个人 API 的预算要算），现在只看保留天数。
 */
export function auditCutoff(now: number, retentionDays: number): number {
  return now - retentionDays * DAY_MS;
}
