// 对外动作（契约 4.8）在 E2 这边的接口。B（#33）合进 main 之前用这里的桩：永远关着，每次尝试都记一笔日志。
// B 合进来以后 index.ts 传 B 的 ExternalActions（同样的 allowed / attempt 形状），B 的登记表加上 branch_push。
export type OutwardKind = "branch_push" | "pr_open";

export interface OutwardScope {
  repoSlug?: string | null;
  productIds?: number[];
  ticketKey?: string | null;
}

export interface OutwardDetail {
  scope?: OutwardScope;
  /** 目标：分支名、PR 链接。 */
  target?: string | null;
  summary: string;
  payload?: string | null;
}

export type OutwardAttempt<T> = { ran: false; auditId: number } | { ran: true; value: T; auditId: number };

export interface OutwardGate {
  allowed(kind: OutwardKind, scope?: OutwardScope): boolean;
  attempt<T>(kind: OutwardKind, detail: OutwardDetail, run: () => Promise<T>): Promise<OutwardAttempt<T>>;
}

/** B 合进来之前的桩：都关着，不跑 run，只记日志。 */
export function stubOutward(log: (msg: string) => void): OutwardGate {
  return {
    allowed: () => false,
    attempt: async (kind, detail) => {
      log(`outward ${kind} skipped (switch off): ${detail.summary}${detail.target ? ` -> ${detail.target}` : ""}${detail.scope?.repoSlug ? ` [${detail.scope.repoSlug}]` : ""}`);
      return { ran: false, auditId: 0 };
    },
  };
}
