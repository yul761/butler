import type { Db } from "./database";
import type { BriefView, Readiness, ReadinessCondition, ReviewTarget, Risk, RiskLevel, RiskReason } from "../../shared/prereview";

export interface StoredReadiness extends Readiness {
  prId: number;
  headSha: string | null;
  computedAt: number;
}

export interface StoredRisk extends Risk {
  prId: number;
  headSha: string | null;
  inputs: Record<string, unknown>;
  rulesVersion: number;
  computedAt: number;
}

export interface NewBrief {
  prId: number | null;
  preReviewId: number | null;
  target: ReviewTarget;
  markdown: string;
  summaryOk: boolean;
  createdAt: number;
}

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function json<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toBrief(r: Row): BriefView & { auditId: number | null } {
  return {
    id: Number(r.id), prId: n(r.pr_id), preReviewId: n(r.pre_review_id),
    target: { repoSlug: String(r.repo_slug), branch: String(r.branch), headSha: String(r.head_sha) },
    markdown: String(r.markdown), summaryOk: Number(r.summary_ok) === 1, createdAt: Number(r.created_at),
    postedAt: n(r.posted_at), postedUrl: s(r.posted_url), auditId: n(r.audit_id),
  };
}

export type StoredBrief = ReturnType<typeof toBrief>;

/** 就绪度、风险、简报（工作流 G，契约 4.6；都以 ticket_prs.id 为键，简报在 PR 之前可能没有 pr_id）。 */
export class AssessRepo {
  constructor(private readonly db: Db) {}

  readiness(prId: number): StoredReadiness | null {
    const r = this.db.prepare(`SELECT * FROM pr_readiness WHERE pr_id = ?`).get(prId) as Row | undefined;
    if (!r) return null;
    return {
      prId, headSha: s(r.head_sha), ready: Number(r.ready) === 1, conditions: json<ReadinessCondition[]>(r.conditions, []),
      missing: json<Readiness["missing"]>(r.missing, []), computedAt: Number(r.computed_at),
    };
  }

  /** 写就绪度；内容（提交、结论、条件）没变不写。返回之前的结论（null = 以前没有），和这次是否写了。 */
  setReadiness(prId: number, headSha: string | null, v: Readiness, at: number): { changed: boolean; before: boolean | null } {
    const prev = this.readiness(prId);
    const conditions = JSON.stringify(v.conditions);
    const missing = JSON.stringify(v.missing);
    if (prev && prev.headSha === headSha && prev.ready === v.ready && JSON.stringify(prev.conditions) === conditions) {
      return { changed: false, before: prev.ready };
    }
    this.db
      .prepare(
        `INSERT INTO pr_readiness (pr_id, head_sha, ready, conditions, missing, computed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (pr_id) DO UPDATE SET head_sha = excluded.head_sha, ready = excluded.ready, conditions = excluded.conditions,
           missing = excluded.missing, computed_at = excluded.computed_at`,
      )
      .run(prId, headSha, v.ready ? 1 : 0, conditions, missing, at);
    return { changed: true, before: prev ? prev.ready : null };
  }

  risk(prId: number): StoredRisk | null {
    const r = this.db.prepare(`SELECT * FROM pr_risk WHERE pr_id = ?`).get(prId) as Row | undefined;
    if (!r) return null;
    return {
      prId, headSha: s(r.head_sha), level: r.level as RiskLevel, reasons: json<RiskReason[]>(r.reasons, []),
      inputs: json<Record<string, unknown>>(r.inputs, {}), rulesVersion: Number(r.rules_version), computedAt: Number(r.computed_at),
    };
  }

  /** 写风险；内容（提交、级别、原因、规则版本）没变不写。返回之前的级别。 */
  setRisk(
    prId: number, headSha: string | null, v: Risk, inputs: Record<string, unknown>, rulesVersion: number, at: number,
  ): { changed: boolean; before: RiskLevel | null } {
    const prev = this.risk(prId);
    const reasons = JSON.stringify(v.reasons);
    if (prev && prev.headSha === headSha && prev.level === v.level && prev.rulesVersion === rulesVersion && JSON.stringify(prev.reasons) === reasons) {
      return { changed: false, before: prev.level };
    }
    this.db
      .prepare(
        `INSERT INTO pr_risk (pr_id, head_sha, level, reasons, inputs, rules_version, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pr_id) DO UPDATE SET head_sha = excluded.head_sha, level = excluded.level, reasons = excluded.reasons,
           inputs = excluded.inputs, rules_version = excluded.rules_version, computed_at = excluded.computed_at`,
      )
      .run(prId, headSha, v.level, reasons, JSON.stringify(inputs), rulesVersion, at);
    return { changed: true, before: prev ? prev.level : null };
  }

  /** 一批 PR 的风险和就绪（「进度」页排序用）。 */
  summaries(prIds: number[]): Map<number, { risk: RiskLevel | null; ready: boolean | null; missing: Readiness["missing"] }> {
    const out = new Map<number, { risk: RiskLevel | null; ready: boolean | null; missing: Readiness["missing"] }>();
    if (prIds.length === 0) return out;
    const marks = prIds.map(() => "?").join(",");
    for (const id of prIds) out.set(id, { risk: null, ready: null, missing: [] });
    for (const r of this.db.prepare(`SELECT pr_id, level FROM pr_risk WHERE pr_id IN (${marks})`).all(...prIds) as Row[]) {
      out.get(Number(r.pr_id))!.risk = r.level as RiskLevel;
    }
    for (const r of this.db.prepare(`SELECT pr_id, ready, missing FROM pr_readiness WHERE pr_id IN (${marks})`).all(...prIds) as Row[]) {
      const o = out.get(Number(r.pr_id))!;
      o.ready = Number(r.ready) === 1;
      o.missing = json<Readiness["missing"]>(r.missing, []);
    }
    return out;
  }

  // ---------------------------------------------------------------- 简报

  /** 存一份简报；和这份代码最近一份内容一样就不新增，返回那一份的 id。 */
  addBrief(b: NewBrief): { id: number; created: boolean } {
    const last = this.latestBriefFor(b.target);
    if (last && last.markdown === b.markdown && last.summaryOk === b.summaryOk) {
      if (b.prId !== null && last.prId === null) this.db.prepare(`UPDATE pr_briefs SET pr_id = ? WHERE id = ?`).run(b.prId, last.id);
      return { id: last.id, created: false };
    }
    const res = this.db
      .prepare(
        `INSERT INTO pr_briefs (pr_id, pre_review_id, repo_slug, branch, head_sha, markdown, summary_ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(b.prId, b.preReviewId, b.target.repoSlug, b.target.branch, b.target.headSha, b.markdown, b.summaryOk ? 1 : 0, b.createdAt);
    return { id: Number(res.lastInsertRowid), created: true };
  }

  brief(id: number): StoredBrief | null {
    const r = this.db.prepare(`SELECT * FROM pr_briefs WHERE id = ?`).get(id) as Row | undefined;
    return r ? toBrief(r) : null;
  }

  latestBriefFor(t: ReviewTarget): StoredBrief | null {
    const r = this.db
      .prepare(`SELECT * FROM pr_briefs WHERE repo_slug = ? AND branch = ? AND head_sha = ? ORDER BY id DESC LIMIT 1`)
      .get(t.repoSlug, t.branch, t.headSha) as Row | undefined;
    return r ? toBrief(r) : null;
  }

  latestBriefForBranch(repoSlug: string, branch: string): StoredBrief | null {
    const r = this.db
      .prepare(`SELECT * FROM pr_briefs WHERE repo_slug = ? AND branch = ? ORDER BY id DESC LIMIT 1`)
      .get(repoSlug, branch) as Row | undefined;
    return r ? toBrief(r) : null;
  }

  latestBriefForPr(prId: number): StoredBrief | null {
    const r = this.db.prepare(`SELECT * FROM pr_briefs WHERE pr_id = ? ORDER BY id DESC LIMIT 1`).get(prId) as Row | undefined;
    return r ? toBrief(r) : null;
  }

  /** 这个 PR 有没有贴过简报（效果统计用）。 */
  briefPosted(prId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM pr_briefs WHERE pr_id = ? AND posted_at IS NOT NULL LIMIT 1`).get(prId);
  }

  markPosted(id: number, url: string, at: number, auditId: number | null): void {
    this.db.prepare(`UPDATE pr_briefs SET posted_at = ?, posted_url = ?, audit_id = ? WHERE id = ?`).run(at, url, auditId, id);
  }
}
