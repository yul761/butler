// review 简报的生成和贴到 PR（设计 §8.2）。默认只在 Shipherd 里看；「贴到 PR」是用户亲手点的（record 审计），
// 自动贴要 externalPrBriefPost 打开（attempt）。K 开栈底 PR 时用 briefProvider 拿简报。
import type { AssessRepo, StoredBrief } from "../db/assess-repo";
import type { PreReviewRepo, PreReviewRow } from "../db/prereview-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import type { ExternalActions } from "../external/actions";
import type { BriefLayer, BriefProvider, EvidenceGap, Risk } from "../../shared/prereview";
import type { ResolvedPrPolicy } from "../../shared/pr-policy";
import { briefSummaryByModel, type ExecRun } from "../prereview/model";
import type { AssessmentService } from "./assessment-service";
import { renderBrief, upsertBriefBlock } from "./brief";
import { stripShipherdBlocks, type Lang } from "./readiness";

/** 送给模型的 PR 描述最多这么多字。 */
const DESCRIPTION_CHARS = 4000;

export interface BriefServiceDeps {
  repo: AssessRepo;
  preReviews: Pick<PreReviewRepo, "get" | "evidenceOf">;
  prs: { get(id: number): TicketPr | null };
  assessment: Pick<AssessmentService, "riskInput" | "riskOf" | "description">;
  gaps(row: PreReviewRow): EvidenceGap[];
  policy(slug: string): ResolvedPrPolicy;
  ticketTitle(key: string | null): string | null;
  exec: ExecRun;
  external: Pick<ExternalActions, "allowed" | "attempt" | "record">;
  /** gh 在哪个目录跑（PR 所在仓库）；没有为 null。 */
  ghCwd(pr: TicketPr): string | null;
  gh: { body(cwd: string, ref: string): Promise<string | null>; edit(o: { cwd: string; ref: string; body: string }): Promise<void> };
  lang(): Lang;
  changed(): void;
  now(): number;
  log(msg: string, err?: unknown): void;
}

export type PostResult = { ok: true; url: string } | { ok: false; reason: "no_pr" | "not_open" | "no_brief" | "off" | "failed"; detail?: string };

export class BriefService {
  constructor(private readonly d: BriefServiceDeps) {}

  /** 预审完成后（或「重新生成」）：为这份代码生成一份简报，然后按开关自动贴。 */
  async generate(row: PreReviewRow): Promise<StoredBrief | null> {
    const pr = row.prId !== null ? this.d.prs.get(row.prId) : null;
    const lang = this.d.lang();
    const evidence = this.d.preReviews.evidenceOf(row.id);
    const gaps = row.status === "done" || row.status === "failed" ? this.d.gaps(row) : [];
    const ticketTitle = this.d.ticketTitle(row.ticketKey);
    const policy = this.d.policy(row.target.repoSlug);
    const desc = pr ? this.d.assessment.description(pr.id) : null;
    const summary = await briefSummaryByModel(this.d.exec, {
      cwd: row.cwd ?? process.cwd(), ticketKey: row.ticketKey, ticketTitle, prTitle: pr?.title ?? null,
      description: desc ? stripShipherdBlocks(desc).slice(0, DESCRIPTION_CHARS) : null, files: row.files,
      acceptance: evidence.filter((e) => e.kind === "acceptance").map((e) => ({ criterion: e.name, how: e.summary })), lang,
    });
    let risk: Risk | null = pr && pr.headSha === row.target.headSha ? this.d.repo.risk(pr.id) : null;
    if (!risk && row.files.length) {
      const input = this.d.assessment.riskInput({ pr, row, files: row.files, gaps, ticketKey: row.ticketKey, branch: row.target.branch, labels: pr?.labels ?? [] });
      const r = this.d.assessment.riskOf(input, row.target.repoSlug);
      risk = { level: r.level, reasons: r.reasons };
    }
    const markdown = renderBrief({
      lang, summary, ticketKey: row.ticketKey, ticketTitle, prTitle: pr?.title ?? null, files: row.files, risk, evidence, gaps,
      preReview: row.status === "done" || row.status === "failed" ? { verdict: row.verdict, violations: row.violations } : null,
      notes: row.notes, policy: policy.risk,
    });
    const { id, created } = this.d.repo.addBrief({ prId: row.prId, preReviewId: row.id, target: row.target, markdown, summaryOk: summary !== null, createdAt: this.d.now() });
    if (created) this.d.changed();
    const brief = this.d.repo.brief(id);
    if (brief && pr && pr.state === "open" && !pr.isDraft && pr.headSha === row.target.headSha && brief.postedAt === null) {
      if (this.d.external.allowed("pr_brief_post", { repoSlug: pr.slug, ticketKey: pr.ticketKey })) await this.post(pr.id, false);
    }
    return brief;
  }

  /** 贴到 PR：已有简报块就整块替换，没有就追加；块以外的描述不动。manual = 用户亲手点的。 */
  async post(prId: number, manual: boolean): Promise<PostResult> {
    const pr = this.d.prs.get(prId);
    if (!pr) return { ok: false, reason: "no_pr" };
    if (pr.state !== "open") return { ok: false, reason: "not_open" };
    const brief = (pr.headSha && pr.headBranch ? this.d.repo.latestBriefFor({ repoSlug: pr.slug, branch: pr.headBranch, headSha: pr.headSha }) : null) ?? this.d.repo.latestBriefForPr(pr.id);
    if (!brief) return { ok: false, reason: "no_brief" };
    const cwd = this.d.ghCwd(pr);
    if (!cwd) return { ok: false, reason: "failed", detail: "no local checkout for this repo" };
    const detail = {
      scope: { repoSlug: pr.slug, ticketKey: pr.ticketKey }, target: pr.url,
      summary: `review brief → ${pr.slug}#${pr.number}`, payload: brief.markdown,
    };
    const run = async () => {
      const body = await this.d.gh.body(cwd, pr.url);
      if (body === null) throw new Error("could not read the PR description");
      const next = upsertBriefBlock(body, brief.markdown);
      if (next !== body) await this.d.gh.edit({ cwd, ref: pr.url, body: next });
    };
    let auditId: number;
    if (manual) {
      try {
        await run();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.d.external.record("pr_brief_post", { ...detail, outcome: "failed", error: msg });
        return { ok: false, reason: "failed", detail: msg };
      }
      auditId = this.d.external.record("pr_brief_post", { ...detail, outcome: "done" });
    } else {
      let r;
      try {
        r = await this.d.external.attempt("pr_brief_post", detail, run);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.d.log(`brief: posting to ${pr.url} failed`, e);
        return { ok: false, reason: "failed", detail: msg };
      }
      if (!r.ran) return { ok: false, reason: "off" };
      auditId = r.auditId;
    }
    this.d.repo.markPosted(brief.id, pr.url, this.d.now(), auditId || null);
    this.d.changed();
    return { ok: true, url: pr.url };
  }

  /** K 的注入点：开关关着、或这份代码没有简报时返回 null。同步。 */
  readonly briefProvider: BriefProvider = (layer: BriefLayer) => {
    if (!this.d.external.allowed("pr_brief_post", { repoSlug: layer.repoSlug, ticketKey: layer.ticketKey })) return null;
    const brief = layer.headSha
      ? this.d.repo.latestBriefFor({ repoSlug: layer.repoSlug, branch: layer.branch, headSha: layer.headSha })
      : this.d.repo.latestBriefForBranch(layer.repoSlug, layer.branch);
    if (!brief) return null;
    return {
      markdown: brief.markdown,
      posted: (prUrl: string) => {
        try {
          const auditId = this.d.external.record("pr_brief_post", {
            scope: { repoSlug: layer.repoSlug, ticketKey: layer.ticketKey }, target: prUrl, summary: `review brief → ${prUrl} (stack)`, payload: brief.markdown, outcome: "done",
          });
          this.d.repo.markPosted(brief.id, prUrl, this.d.now(), auditId || null);
          this.d.changed();
        } catch (e) {
          this.d.log("brief: recording a stack post failed", e);
        }
      },
    };
  };
}
