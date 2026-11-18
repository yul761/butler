// 对外动作的开关和审计（契约 4.8，设计文档 2026-11-17 ws-b 第 5 节）。
// 会在 GitHub 或别的外部服务上留下东西的动作（回评论、改 PR、强推、发 issue、推送通知……）一律先问 allowed，
// 做没做都 record。接入的 workstream 用 attempt：开关关着时不跑，只记一笔 skipped。
import { EXTERNAL_ACTION_SETTINGS, EXTERNAL_ACTIONS, type ExternalActionKind, type ExternalActionSetting, type ExternalOutcome } from "../../shared/external";
import type { ExternalAuditRepo } from "../db/external-audit-repo";

export { EXTERNAL_ACTIONS, type ExternalActionKind };

/** 动作作用在哪里：分层设置（契约 4.2）按它找覆盖。 */
export interface ExternalScope {
  repoSlug?: string | null;
  productIds?: number[];
  ticketKey?: string | null;
}

export interface ExternalDetail {
  scope?: ExternalScope;
  /** 目标：PR、评论、issue 的链接之类。 */
  target?: string | null;
  /** 一句话：做了什么。 */
  summary: string;
  /** 发出去的内容（评论正文、新标题……）。 */
  payload?: string | null;
}

export interface ExternalActionsDeps {
  repo: Pick<ExternalAuditRepo, "insert" | "prune">;
  /** 全局设置。 */
  setting(key: ExternalActionSetting): string;
  /**
   * 分层设置（契约 4.2）：这个范围里有没有覆盖。没有返回 undefined，回到全局。
   * 分层设置合进来之前不注入，只看全局。
   */
  layered?: (key: ExternalActionSetting, scope: ExternalScope) => string | undefined;
  now(): number;
  /** 保留期的起点（auditCutoff）；不给就不清理。 */
  cutoff?: (now: number) => number;
  log?(msg: string, err?: unknown): void;
}

export type AttemptResult<T> = { ran: false; auditId: number } | { ran: true; value: T; auditId: number };

export class ExternalActions {
  private lastPrune = Number.NEGATIVE_INFINITY;

  constructor(private readonly d: ExternalActionsDeps) {}

  /** 这种动作现在能不能做：先看范围里的覆盖，再看全局；只有 "1" 算开。 */
  allowed(kind: ExternalActionKind, scope: ExternalScope = {}): boolean {
    const key = EXTERNAL_ACTION_SETTINGS[kind];
    let v: string | undefined;
    try {
      v = this.d.layered?.(key, scope);
    } catch (e) {
      this.d.log?.(`external actions: layered setting ${key} failed`, e);
    }
    return (v ?? this.d.setting(key)).trim() === "1";
  }

  /** 记一笔审计；返回审计 id。写审计失败只记日志（返回 0），不影响调用方。 */
  record(kind: ExternalActionKind, detail: ExternalDetail & { outcome: ExternalOutcome; error?: string | null }): number {
    try {
      const now = this.d.now();
      this.prune(now);
      return this.d.repo.insert({
        ts: now, kind, repoSlug: detail.scope?.repoSlug ?? null, ticketKey: detail.scope?.ticketKey ?? null, target: detail.target ?? null,
        summary: detail.summary, payload: detail.payload ?? null, outcome: detail.outcome, error: detail.error ?? null,
      });
    } catch (e) {
      this.d.log?.(`external actions: recording ${kind} failed`, e);
      return 0;
    }
  }

  /**
   * 开关开着才跑 run，并按结果记 done / failed（run 抛错照样抛出去）；关着不跑，记一笔 skipped，
   * 方便在审计页抽查"本来会做什么"。
   */
  async attempt<T>(kind: ExternalActionKind, detail: ExternalDetail, run: () => Promise<T>): Promise<AttemptResult<T>> {
    const scope = detail.scope ?? {};
    if (!this.allowed(kind, scope)) return { ran: false, auditId: this.record(kind, { ...detail, outcome: "skipped" }) };
    try {
      const value = await run();
      return { ran: true, value, auditId: this.record(kind, { ...detail, outcome: "done" }) };
    } catch (e) {
      this.record(kind, { ...detail, outcome: "failed", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  /** 保留期：最多一小时清一次。 */
  private prune(now: number): void {
    if (!this.d.cutoff || now - this.lastPrune < 3600_000) return;
    this.lastPrune = now;
    this.d.repo.prune(this.d.cutoff(now));
  }
}
