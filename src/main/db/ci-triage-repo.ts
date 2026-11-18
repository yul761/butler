import type { Db } from "./database";
import type { FlakyEntry, FlakyKind } from "../../shared/loop";

export type TriageState = "classifying" | "classified" | "rerunning" | "delivered" | "passed" | "abandoned";
export type TriageCategory = "env" | "flaky" | "code";

/** ci_triage 的一行：一个条目（PR 行或分支行）一个 head sha 上的一个失败的 run。 */
export interface TriageRow {
  id: number;
  itemKind: "pr" | "branch";
  itemId: number;
  repoSlug: string | null;
  ticketKey: string | null;
  headSha: string;
  runId: number;
  checks: string[];
  tests: string[];
  attempt: number;
  category: TriageCategory | null;
  source: string | null;
  reason: string | null;
  signature: string | null;
  prevSignature: string | null;
  reruns: number;
  rerunAttempt: number | null;
  state: TriageState;
  /** 最后怎么处理的：code / possibly_flaky / same_twice / rerun_off / rerun_failed / passed。 */
  outcome: string | null;
  firstFailedAt: number;
  rerunAt: number | null;
  passedAt: number | null;
  deliveredAt: number | null;
  updatedAt: number;
}

export type TriagePatch = Partial<Pick<TriageRow,
  "checks" | "tests" | "attempt" | "category" | "source" | "reason" | "signature" | "prevSignature" | "reruns" | "rerunAttempt" | "state" | "outcome" | "rerunAt" | "passedAt" | "deliveredAt">>;

const COLUMNS: Record<keyof TriagePatch, string> = {
  checks: "checks", tests: "tests", attempt: "attempt", category: "category", source: "source", reason: "reason", signature: "signature", prevSignature: "prev_signature",
  reruns: "reruns", rerunAttempt: "rerun_attempt", state: "state", outcome: "outcome", rerunAt: "rerun_at", passedAt: "passed_at", deliveredAt: "delivered_at",
};

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const list = (v: unknown): string[] => {
  try {
    const j: unknown = JSON.parse(String(v ?? "[]"));
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

function toRow(r: Row): TriageRow {
  return {
    id: Number(r.id), itemKind: r.item_kind as "pr" | "branch", itemId: Number(r.item_id), repoSlug: s(r.repo_slug), ticketKey: s(r.ticket_key), headSha: String(r.head_sha),
    runId: Number(r.run_id), checks: list(r.checks), tests: list(r.tests), attempt: Number(r.attempt), category: (r.category as TriageCategory | null) ?? null,
    source: s(r.source), reason: s(r.reason), signature: s(r.signature), prevSignature: s(r.prev_signature), reruns: Number(r.reruns), rerunAttempt: n(r.rerun_attempt),
    state: r.state as TriageState, outcome: s(r.outcome), firstFailedAt: Number(r.first_failed_at), rerunAt: n(r.rerun_at), passedAt: n(r.passed_at),
    deliveredAt: n(r.delivered_at), updatedAt: Number(r.updated_at),
  };
}

export interface ItemRef { kind: "pr" | "branch"; id: number }

export class CiTriageRepo {
  constructor(private readonly db: Db) {}

  get(item: ItemRef, headSha: string, runId: number): TriageRow | null {
    const r = this.db.prepare(`SELECT * FROM ci_triage WHERE item_kind = ? AND item_id = ? AND head_sha = ? AND run_id = ?`).get(item.kind, item.id, headSha, runId) as Row | undefined;
    return r ? toRow(r) : null;
  }

  byId(id: number): TriageRow | null {
    const r = this.db.prepare(`SELECT * FROM ci_triage WHERE id = ?`).get(id) as Row | undefined;
    return r ? toRow(r) : null;
  }

  create(i: { item: ItemRef; repoSlug: string | null; ticketKey: string | null; headSha: string; runId: number; checks: string[]; now: number }): TriageRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ci_triage (item_kind, item_id, repo_slug, ticket_key, head_sha, run_id, checks, state, first_failed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'classifying', ?, ?)`,
      )
      .run(i.item.kind, i.item.id, i.repoSlug, i.ticketKey, i.headSha, i.runId, JSON.stringify(i.checks), i.now, i.now);
    return this.get(i.item, i.headSha, i.runId) as TriageRow;
  }

  update(id: number, patch: TriagePatch, now: number): void {
    const keys = Object.keys(patch) as (keyof TriagePatch)[];
    if (keys.length === 0) return;
    const val = (k: keyof TriagePatch): string | number | null => {
      const v = patch[k];
      return Array.isArray(v) ? JSON.stringify(v) : ((v ?? null) as string | number | null);
    };
    this.db.prepare(`UPDATE ci_triage SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map(val), now, id);
  }

  /** 这个条目这个 sha 上的所有行。 */
  atSha(item: ItemRef, headSha: string): TriageRow[] {
    return (this.db.prepare(`SELECT * FROM ci_triage WHERE item_kind = ? AND item_id = ? AND head_sha = ? ORDER BY id`).all(item.kind, item.id, headSha) as Row[]).map(toRow);
  }

  /** 这个条目在 id 之前最近的一行，检查名一样的（「连续两次同样的失败」看它）。 */
  previous(item: ItemRef, beforeId: number, checks: readonly string[]): TriageRow | null {
    const key = JSON.stringify([...checks].sort());
    const rows = (this.db.prepare(`SELECT * FROM ci_triage WHERE item_kind = ? AND item_id = ? AND id < ? ORDER BY id DESC LIMIT 20`).all(item.kind, item.id, beforeId) as Row[]).map(toRow);
    return rows.find((r) => JSON.stringify([...r.checks].sort()) === key) ?? null;
  }

  /** 还没处理完的行（重启后接着处理）。 */
  open(): TriageRow[] {
    return (this.db.prepare(`SELECT * FROM ci_triage WHERE state IN ('classifying', 'classified', 'rerunning') ORDER BY id`).all() as Row[]).map(toRow);
  }

  /** 这个条目上换了 sha 的、还没处理完的行：不再等。 */
  abandonOthers(item: ItemRef, headSha: string, now: number): void {
    this.db
      .prepare(`UPDATE ci_triage SET state = 'abandoned', updated_at = ? WHERE item_kind = ? AND item_id = ? AND head_sha <> ? AND state IN ('classifying', 'classified', 'rerunning')`)
      .run(now, item.kind, item.id, headSha);
  }

  addFlaky(e: { repoSlug: string; kind: FlakyKind; name: string; triageId: number | null; at: number; wastedMs: number }): void {
    this.db.prepare(`INSERT INTO ci_flaky_events (repo_slug, kind, name, triage_id, at, wasted_ms) VALUES (?, ?, ?, ?, ?, ?)`).run(e.repoSlug, e.kind, e.name, e.triageId, e.at, e.wastedMs);
  }

  flakyCount(repoSlug: string, kind: FlakyKind, name: string, since: number): number {
    return Number((this.db.prepare(`SELECT COUNT(*) c FROM ci_flaky_events WHERE repo_slug = ? AND kind = ? AND name = ? AND at >= ?`).get(repoSlug, kind, name, since) as { c: number }).c);
  }

  /** 列入名单；已经在名单里不改来源。返回是不是新加的。 */
  list(repoSlug: string, kind: FlakyKind, name: string, source: "auto" | "manual", now: number): boolean {
    return Number(this.db.prepare(`INSERT OR IGNORE INTO ci_flaky_list (repo_slug, kind, name, source, added_at) VALUES (?, ?, ?, ?, ?)`).run(repoSlug, kind, name, source, now).changes) > 0;
  }

  unlist(repoSlug: string, kind: FlakyKind, name: string): boolean {
    return Number(this.db.prepare(`DELETE FROM ci_flaky_list WHERE repo_slug = ? AND kind = ? AND name = ?`).run(repoSlug, kind, name).changes) > 0;
  }

  /** 这个仓库名单上的名字（分类规则用）。 */
  listed(repoSlug: string): string[] {
    return (this.db.prepare(`SELECT name FROM ci_flaky_list WHERE repo_slug = ? ORDER BY id`).all(repoSlug) as { name: string }[]).map((r) => r.name);
  }

  /** 设置页和效果页：名单上的和窗口内 flaky 过的，按次数从多到少。 */
  flakyEntries(since: number, limit = 200): FlakyEntry[] {
    const rows = this.db
      .prepare(
        `SELECT k.repo_slug, k.kind, k.name,
           (SELECT COUNT(*) FROM ci_flaky_events e WHERE e.repo_slug = k.repo_slug AND e.kind = k.kind AND e.name = k.name AND e.at >= ?) AS count,
           (SELECT COALESCE(SUM(wasted_ms), 0) FROM ci_flaky_events e WHERE e.repo_slug = k.repo_slug AND e.kind = k.kind AND e.name = k.name AND e.at >= ?) AS wasted,
           (SELECT MAX(at) FROM ci_flaky_events e WHERE e.repo_slug = k.repo_slug AND e.kind = k.kind AND e.name = k.name) AS last_at,
           (SELECT source FROM ci_flaky_list l WHERE l.repo_slug = k.repo_slug AND l.kind = k.kind AND l.name = k.name) AS listed
         FROM (SELECT repo_slug, kind, name FROM ci_flaky_events WHERE at >= ? UNION SELECT repo_slug, kind, name FROM ci_flaky_list) k
         ORDER BY count DESC, wasted DESC, k.name LIMIT ?`,
      )
      .all(since, since, since, limit) as Row[];
    return rows.map((r) => ({
      repoSlug: String(r.repo_slug), kind: r.kind as FlakyKind, name: String(r.name), count: Number(r.count), wastedMs: Number(r.wasted), lastAt: n(r.last_at),
      listed: (r.listed as "auto" | "manual" | null) ?? null,
    }));
  }

  /** 效果页的 CI 部分。flaky 次数和浪费的时间只算检查（同一次 flaky 的测试名另记，不重复算）。 */
  stats(since: number, until: number): { triaged: number; env: number; flaky: number; code: number; reruns: number; passed: number; deliveredAsCode: number; possiblyFlaky: number; wastedMs: number } {
    const one = (sql: string): number => Number((this.db.prepare(sql).get(since, until) as { c: number }).c ?? 0);
    const range = `BETWEEN ? AND ?`;
    return {
      triaged: one(`SELECT COUNT(*) c FROM ci_triage WHERE category IS NOT NULL AND first_failed_at ${range}`),
      env: one(`SELECT COUNT(*) c FROM ci_triage WHERE category = 'env' AND first_failed_at ${range}`),
      flaky: one(`SELECT COUNT(*) c FROM ci_triage WHERE category = 'flaky' AND first_failed_at ${range}`),
      code: one(`SELECT COUNT(*) c FROM ci_triage WHERE category = 'code' AND first_failed_at ${range}`),
      reruns: one(`SELECT COALESCE(SUM(reruns), 0) c FROM ci_triage WHERE first_failed_at ${range}`),
      passed: one(`SELECT COUNT(*) c FROM ci_triage WHERE state = 'passed' AND passed_at ${range}`),
      deliveredAsCode: one(`SELECT COUNT(*) c FROM ci_triage WHERE state = 'delivered' AND delivered_at ${range}`),
      possiblyFlaky: one(`SELECT COUNT(*) c FROM ci_triage WHERE outcome = 'possibly_flaky' AND delivered_at ${range}`),
      wastedMs: one(`SELECT COALESCE(SUM(wasted_ms), 0) c FROM ci_flaky_events WHERE kind = 'check' AND at ${range}`),
    };
  }
}
