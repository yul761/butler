import type { ResolvedPrPolicy } from "../../shared/pr-policy";
import type { ConditionState, EvidenceGap, Readiness, ReadinessCondition, ReadinessKey } from "../../shared/prereview";

/** 算就绪要的输入（设计 §7）：全是确定的数据。 */
export interface ReadinessInput {
  ci: "pending" | "passing" | "failing" | null;
  /** session 未解决的 block 级检查失败（enforce 模式）。 */
  blockFailures: number;
  /** 预审开着吗（关着时 pre_review 和 evidence 两条为 off）。 */
  preReviewEnabled: boolean;
  /** 最新一次预审：对应哪个 sha、状态和结论、违规级别统计。 */
  preReview: { headSha: string; status: "queued" | "running" | "done" | "failed" | "skipped"; verdict: "clean" | "violations" | "error" | null; should: number } | null;
  headSha: string | null;
  /** 证据缺口（没有预审时为 null = 还不知道）。 */
  evidenceGaps: EvidenceGap[] | null;
  /** 未处理的评论数；null = 读不到。 */
  openComments: number | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  /** 合并总控在让它等别人。 */
  waitingOnGate: boolean;
  /** PR 描述原文（只在主进程里用）。 */
  description: string | null;
}

export type Lang = "en" | "zh";

const T = {
  en: {
    ciPassing: "CI passing", ciFailing: "CI failing", ciPending: "CI still running", ciNone: "no CI result yet",
    blocks: (n: number) => `${n} unresolved blocking check failure${n === 1 ? "" : "s"}`,
    prOff: "pre-review is off", prNone: "no pre-review yet", prRunning: "pre-review running", prOld: "pre-review is for an older commit",
    prClean: "pre-review clean", prViolations: "pre-review found violations", prError: "pre-review failed", prShould: (n: number) => `pre-review clean (${n} should-level notes)`,
    evOff: "pre-review is off", evUnknown: "evidence not checked yet", evOk: "evidence complete",
    commentsOk: "no open review comments", commentsOpen: (n: number) => `${n} open review comment${n === 1 ? "" : "s"}`, commentsUnknown: "review comments not read yet",
    mergeOk: "no conflicts", mergeConflict: "has merge conflicts", mergeUnknown: "mergeability not known yet", mergeWaiting: "waiting on the merge gate",
    descOk: "description covers what, why and how verified", descShort: (n: number, min: number) => `description too short (${n}/${min} chars)`,
    descMissing: (parts: string[]) => `description lacks: ${parts.join(", ")}`, descNone: "no description",
    parts: { what: "what changed", why: "why", verify: "how it was verified" },
    gap: (g: EvidenceGap) => (g.state === "missing" ? `missing ${CAT.en[g.category]}` : g.state === "explained" ? `${CAT.en[g.category]} not run: ${g.detail}` : `${CAT.en[g.category]} does not match: ${g.detail}`),
  },
  zh: {
    ciPassing: "CI 通过", ciFailing: "CI 失败", ciPending: "CI 还在跑", ciNone: "还没有 CI 结果",
    blocks: (n: number) => `${n} 个阻断级检查失败没解决`,
    prOff: "预审没开", prNone: "还没预审", prRunning: "预审进行中", prOld: "预审对应的是旧提交",
    prClean: "预审通过", prViolations: "预审有违规", prError: "预审失败", prShould: (n: number) => `预审通过（${n} 条建议）`,
    evOff: "预审没开", evUnknown: "证据还没核实", evOk: "证据齐全",
    commentsOk: "没有未处理的评论", commentsOpen: (n: number) => `${n} 条评论未处理`, commentsUnknown: "评论还没读到",
    mergeOk: "没有冲突", mergeConflict: "有合并冲突", mergeUnknown: "还不知道能不能合并", mergeWaiting: "合并总控让它等别人",
    descOk: "描述写了改了什么、为什么、怎么验证", descShort: (n: number, min: number) => `描述太短（${n}/${min} 字）`,
    descMissing: (parts: string[]) => `描述缺少：${parts.join("、")}`, descNone: "没有描述",
    parts: { what: "改了什么", why: "为什么", verify: "怎么验证" },
    gap: (g: EvidenceGap) => (g.state === "missing" ? `缺${CAT.zh[g.category]}` : g.state === "explained" ? `${CAT.zh[g.category]}没跑：${g.detail}` : `${CAT.zh[g.category]}对不上：${g.detail}`),
  },
};

export const CAT = {
  en: { test: "test output", lint: "lint output", typecheck: "typecheck output", build: "build output", acceptance: "acceptance criteria" },
  zh: { test: "测试输出", lint: "lint 输出", typecheck: "类型检查输出", build: "构建输出", acceptance: "验收条件对照" },
} as const;

/** 去掉 Butler 自己写进描述的块（`<!-- butler:x -->…<!-- /butler:x -->`，以及单独的 butler 注释）。 */
export function stripButlerBlocks(body: string): string {
  return body
    .replace(/<!--\s*butler:([\w-]+)\s*-->[\s\S]*?<!--\s*\/butler:\1\s*-->/g, "")
    .replace(/<!--\s*\/?butler:[^>]*-->/g, "")
    .trim();
}

/** 描述检查（第 6 条）：长度够、三组关键词每组至少一个。返回缺的组。 */
export function checkDescription(body: string | null, p: ResolvedPrPolicy["readiness"]): { ok: boolean; length: number; missing: ("what" | "why" | "verify")[] } {
  const text = stripButlerBlocks(body ?? "");
  const lower = text.toLowerCase();
  const missing = (["what", "why", "verify"] as const).filter((g) => !p.words[g].some((w) => w && lower.includes(w.toLowerCase())));
  const length = [...text].length;
  return { ok: length >= p.descriptionMinChars && missing.length === 0, length, missing };
}

/** 六个条件和结论。ready = 所有启用的条件都是 pass 或 off；unknown 不算就绪。只提示、只排序，不当闸门。 */
export function computeReadiness(input: ReadinessInput, policy: ResolvedPrPolicy["readiness"], lang: Lang = "en"): Readiness {
  const t = T[lang];
  const cond = (key: ReadinessKey, state: ConditionState, detail: string): ReadinessCondition =>
    policy.enabled[key] ? { key, state, detail } : { key, state: "off", detail };
  const conditions: ReadinessCondition[] = [];

  // 1. checks
  if (input.blockFailures > 0) conditions.push(cond("checks", "fail", t.blocks(input.blockFailures)));
  else if (input.ci === "passing") conditions.push(cond("checks", "pass", t.ciPassing));
  else if (input.ci === "failing") conditions.push(cond("checks", "fail", t.ciFailing));
  else conditions.push(cond("checks", "unknown", input.ci === "pending" ? t.ciPending : t.ciNone));

  // 2. pre_review
  const pr = input.preReview;
  if (!input.preReviewEnabled) conditions.push(cond("pre_review", "off", t.prOff));
  else if (!pr) conditions.push(cond("pre_review", "unknown", t.prNone));
  else if (input.headSha && pr.headSha !== input.headSha) conditions.push(cond("pre_review", "fail", t.prOld));
  else if (pr.status === "queued" || pr.status === "running") conditions.push(cond("pre_review", "unknown", t.prRunning));
  else if (pr.status !== "done" || pr.verdict === "error") conditions.push(cond("pre_review", "fail", t.prError));
  else if (pr.verdict === "clean" && pr.should > 0 && policy.shouldBlocks) conditions.push(cond("pre_review", "fail", t.prViolations));
  else if (pr.verdict === "clean") conditions.push(cond("pre_review", "pass", pr.should > 0 ? t.prShould(pr.should) : t.prClean));
  else conditions.push(cond("pre_review", "fail", t.prViolations));

  // 3. evidence
  if (!input.preReviewEnabled) conditions.push(cond("evidence", "off", t.evOff));
  else if (input.evidenceGaps === null) conditions.push(cond("evidence", "unknown", t.evUnknown));
  else if (input.evidenceGaps.length === 0) conditions.push(cond("evidence", "pass", t.evOk));
  else conditions.push(cond("evidence", "fail", input.evidenceGaps.map(t.gap).join(lang === "zh" ? "；" : "; ")));

  // 4. comments
  if (input.openComments === null) conditions.push(cond("comments", "unknown", t.commentsUnknown));
  else if (input.openComments === 0) conditions.push(cond("comments", "pass", t.commentsOk));
  else conditions.push(cond("comments", "fail", t.commentsOpen(input.openComments)));

  // 5. mergeable
  if (input.mergeable === "CONFLICTING") conditions.push(cond("mergeable", "fail", t.mergeConflict));
  else if (input.waitingOnGate) conditions.push(cond("mergeable", "fail", t.mergeWaiting));
  else if (input.mergeable === "MERGEABLE") conditions.push(cond("mergeable", "pass", t.mergeOk));
  else conditions.push(cond("mergeable", "unknown", t.mergeUnknown));

  // 6. description
  if (!input.description || !input.description.trim()) conditions.push(cond("description", "fail", t.descNone));
  else {
    const d = checkDescription(input.description, policy);
    if (d.ok) conditions.push(cond("description", "pass", t.descOk));
    else if (d.length < policy.descriptionMinChars) conditions.push(cond("description", "fail", t.descShort(d.length, policy.descriptionMinChars)));
    else conditions.push(cond("description", "fail", t.descMissing(d.missing.map((m) => t.parts[m]))));
  }

  const missing = conditions.flatMap((c) => (c.state === "fail" || c.state === "unknown" ? [{ key: c.key, state: c.state, detail: c.detail }] : []));
  return { ready: missing.length === 0, conditions, missing };
}
