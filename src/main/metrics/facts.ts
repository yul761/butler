import type { RegistryModel } from "../../shared/model-routing";
import type { Db } from "../db/database";
import type { MergeHold } from "../db/merge-gate-repo";
import type { MetricEvent, WaitSpan } from "../db/metrics-repo";

/** rollup 需要的一个 PR。 */
export interface PrFact {
  id: number;
  ticketKey: string;
  url: string;
  slug: string;
  number: number;
  repoId: number | null;
  /** ticket_repos.repo_path（本地合并的占位按它对）；仓库删了为 null。 */
  repoPath: string | null;
  headBranch: string | null;
  state: "open" | "merged" | "closed";
  openedAt: number | null;
  mergedAt: number | null;
  closedAt: number | null;
  source: string;
}

export interface SessionFact {
  id: string;
  ticketKey: string | null;
  gitBranch: string | null;
  butler: boolean;
  createdAt: number;
}

export interface UsageFact {
  sessionId: string | null;
  at: number;
  model: string | null;
  task: string | null;
  source: "session" | "subagent" | "headless";
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  costUsd: number | null;
}

/** pr_stage_events 里 rollup 用到的：评论、review、CI 结论。 */
export interface StageFact {
  prId: number;
  kind: "comment" | "review" | "ci";
  at: number;
  who: string | null;
  hasBody: boolean;
  result: string | null;
  /** review 的 GitHub id：同一个 review 换了状态（比如被 DISMISSED）会再记一条，按它去重。 */
  reviewId: string | null;
}

export interface OwnerFact {
  ticketKey: string;
  repoId: number;
  branch: string;
  sessionId: string;
}

export interface Facts {
  prs: PrFact[];
  sessions: SessionFact[];
  usage: UsageFact[];
  stages: StageFact[];
  /** `${slug}#${number}` → 最新一次完成的复盘里 avoidable 的条数。 */
  avoidable: Map<string, number>;
  /** 仓库 slug → 所属产品的名字。 */
  products: Map<string, string[]>;
  /** ticket_prs.id → G 给的风险等级（契约 4.6）；没有的不在里面。 */
  risk: Map<number, string>;
  owners: OwnerFact[];
  holds: MergeHold[];
  events: MetricEvent[];
  spans: WaitSpan[];
  registry: RegistryModel[];
}

const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** 有没有这张表。 */
function hasTable(db: Db, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** pr_risk 里放等级的列：level → risk → tier，第一个存在的。 */
const RISK_COLUMNS = ["level", "risk", "tier"];

/**
 * G 的 pr_risk（契约 4.6）：只读。表不存在、没有等级列、读失败都当作全部未分级（空 map）。H 自己不算风险。
 */
export function readRisk(db: Db): Map<number, string> {
  const out = new Map<number, string>();
  try {
    if (!hasTable(db, "pr_risk")) return out;
    const cols = (db.prepare(`PRAGMA table_info(pr_risk)`).all() as unknown as { name: string }[]).map((c) => c.name);
    const col = RISK_COLUMNS.find((c) => cols.includes(c));
    if (!col || !cols.includes("pr_id")) return out;
    for (const r of db.prepare(`SELECT pr_id, ${col} AS level FROM pr_risk`).all() as unknown as { pr_id: number; level: unknown }[]) {
      if (typeof r.level === "string" && r.level.trim()) out.set(Number(r.pr_id), r.level.trim().toLowerCase());
    }
  } catch {
    return new Map();
  }
  return out;
}

export function avoidableCount(json: string | null): number {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    const list = Array.isArray(v) ? v : Array.isArray((v as { findings?: unknown })?.findings) ? (v as { findings: unknown[] }).findings : [];
    return list.filter((f) => f && typeof f === "object" && (f as { avoidable?: unknown }).avoidable === true).length;
  } catch {
    return 0;
  }
}

/** 复盘里 avoidable 的评论数：每个 PR 取最新一次 done 的运行。 */
export function readAvoidable(db: Db): Map<string, number> {
  const out = new Map<string, number>();
  const rows = db
    .prepare(
      `SELECT repo_slug, pr_number, findings_json FROM lesson_runs r
       WHERE status = 'done' AND id = (SELECT MAX(id) FROM lesson_runs x WHERE x.repo_slug = r.repo_slug AND x.pr_number = r.pr_number AND x.status = 'done')`,
    )
    .all() as unknown as { repo_slug: string; pr_number: number; findings_json: string | null }[];
  for (const r of rows) {
    out.set(`${r.repo_slug}#${Number(r.pr_number)}`, avoidableCount(r.findings_json));
  }
  return out;
}

export function readProducts(db: Db): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db
    .prepare(`SELECT pr.repo_slug AS slug, p.name AS name FROM lesson_product_repos pr JOIN lesson_products p ON p.id = pr.product_id ORDER BY p.name`)
    .all() as unknown as { slug: string; name: string }[];
  for (const r of rows) out.set(r.slug, [...(out.get(r.slug) ?? []), r.name]);
  return out;
}

/**
 * 从数据库读出 rollup 要的全部东西。since：事件、用量、等待段从这之后读；PR 不限（合并日再筛），
 * 评论和 CI 只读还开着、或者在 since 之后合并 / 关闭的 PR 的。
 * 都是同步读，跑在主进程里：stage 的 JSON 在 SQL 里取字段，不把评论正文读进 JS。
 */
export function readFacts(db: Db, since: number, extra: { events: MetricEvent[]; spans: WaitSpan[]; holds: MergeHold[]; registry: RegistryModel[] }): Facts {
  const prs = (
    db.prepare(`SELECT p.*, r.repo_path AS repo_path FROM ticket_prs p LEFT JOIN ticket_repos r ON r.id = p.repo_id`).all() as unknown as Record<string, unknown>[]
  ).map(
    (r): PrFact => ({
      id: num(r.id), ticketKey: String(r.ticket_key), url: String(r.url), slug: String(r.slug), number: num(r.number),
      repoId: numOrNull(r.repo_id), repoPath: (r.repo_path as string | null) ?? null, headBranch: (r.head_branch as string | null) ?? null,
      state: r.state as PrFact["state"], openedAt: numOrNull(r.opened_at), mergedAt: numOrNull(r.merged_at), closedAt: numOrNull(r.closed_at),
      source: String(r.source),
    }),
  );
  const sessions = (db.prepare(`SELECT id, ticket_key, git_branch, origin, created_at FROM sessions`).all() as unknown as Record<string, unknown>[]).map(
    (r): SessionFact => ({
      id: String(r.id), ticketKey: (r.ticket_key as string | null) ?? null, gitBranch: (r.git_branch as string | null) ?? null,
      butler: r.origin === "butler", createdAt: num(r.created_at),
    }),
  );
  const usage = (db.prepare(`SELECT * FROM session_usage WHERE at >= ?`).all(since) as unknown as Record<string, unknown>[]).map(
    (r): UsageFact => ({
      sessionId: (r.session_id as string | null) ?? null, at: num(r.at), model: (r.model as string | null) ?? null, task: (r.task as string | null) ?? null,
      source: r.source as UsageFact["source"], input: num(r.input), cacheWrite5m: num(r.cache_write_5m), cacheWrite1h: num(r.cache_write_1h),
      cacheRead: num(r.cache_read), output: num(r.output), costUsd: numOrNull(r.cost_usd),
    }),
  );
  const field = (path: string) => `CASE WHEN json_valid(e.data) THEN json_extract(e.data, '${path}') END`;
  const stageRows = db
    .prepare(
      `SELECT e.pr_id, e.kind, e.at, ${field("$.who")} AS who, ${field("$.result")} AS result, ${field("$.id")} AS rid,
              length(trim(COALESCE(${field("$.body")}, ''))) > 0 AS has_body
       FROM pr_stage_events e JOIN ticket_prs p ON p.id = e.pr_id
       WHERE e.kind IN ('comment', 'review', 'ci') AND (p.merged_at IS NULL OR p.merged_at >= ?) AND (p.closed_at IS NULL OR p.closed_at >= ?)`,
    )
    .all(since, since) as unknown as Record<string, unknown>[];
  const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
  const stages = stageRows.map(
    (r): StageFact => ({
      prId: num(r.pr_id), kind: r.kind as StageFact["kind"], at: num(r.at), who: typeof r.who === "string" ? r.who : null,
      hasBody: Number(r.has_body) === 1, result: typeof r.result === "string" ? r.result : null, reviewId: r.kind === "review" ? str(r.rid) : null,
    }),
  );
  const owners = (db.prepare(`SELECT ticket_key, repo_id, branch, session_id FROM branch_owners`).all() as unknown as Record<string, unknown>[]).map(
    (r): OwnerFact => ({ ticketKey: String(r.ticket_key), repoId: num(r.repo_id), branch: String(r.branch), sessionId: String(r.session_id) }),
  );
  return {
    prs, sessions, usage, stages, owners,
    avoidable: readAvoidable(db), products: readProducts(db), risk: readRisk(db), ...extra,
  };
}
