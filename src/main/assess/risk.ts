import { matchAny } from "../../shared/glob";
import type { ResolvedPrPolicy, RiskPathClass } from "../../shared/pr-policy";
import { RISK_LEVELS, riskRank, type DiffFile, type EvidenceGap, type Risk, type RiskLevel, type RiskReason, type RiskRule } from "../../shared/prereview";

/** 算风险要的全部输入：都是确定的数据，不调模型（设计 §5）。 */
export interface RiskInput {
  files: DiffFile[];
  /** 同一 ticket 还开着的 PR 涉及几个仓库（含这一个）。 */
  openRepoCount: number;
  /** PR 的 CI；没有 PR 为 null。 */
  ci: "pending" | "passing" | "failing" | null;
  /** 复跑的结果：全过 / 有失败 / 没跑。没有 PR 时代替 CI。 */
  rerun: "passed" | "failed" | "none";
  /** session 未解决的检查命中（任何级别、包括影子模式的 fail）。 */
  unresolvedHits: number;
  /** checks_absent 的原因；null = 没缺。 */
  checksAbsent: string | null;
  mustViolations: number;
  /** 要的证据里缺的、或不实的（「已说明」的也算没有这项输出）。 */
  evidenceGaps: EvidenceGap[];
  /** 有没有一条核实过（rerun_pass / consistent）的测试证据。 */
  verifiedTest: boolean;
  ticketType: string | null;
}

export interface RiskStats {
  lines: number;
  files: number;
  generated: number;
}

const pathRule: [RiskPathClass, RiskRule][] = [
  ["migration", "migration"],
  ["auth", "auth"],
  ["publicApi", "public_api"],
  ["config", "config"],
  ["ci", "ci_config"],
];

const RULE_DETAIL: Record<string, string> = {
  migration: "touches a migration or schema",
  auth: "touches auth or permissions",
  public_api: "touches a public API",
  config: "touches config or secrets",
  ci_config: "touches CI config",
};

/** 去掉生成文件之后的改动统计（R6、低风险用）。 */
export function riskStats(files: DiffFile[], p: ResolvedPrPolicy["risk"]): RiskStats {
  let lines = 0;
  let n = 0;
  let generated = 0;
  for (const f of files) {
    if (matchAny(f.path, p.paths.generated)) {
      generated++;
      continue;
    }
    n++;
    lines += f.added + f.deleted;
  }
  return { lines, files: n, generated };
}

const up = (l: RiskLevel): RiskLevel => RISK_LEVELS[Math.min(riskRank(l) + 1, RISK_LEVELS.length - 1)]!;
const max = (a: RiskLevel, b: RiskLevel): RiskLevel => (riskRank(a) >= riskRank(b) ? a : b);

/**
 * 风险等级，规则版本 1（RISK_RULES_VERSION）。按顺序判断，命中的都记进 reasons。
 * R1（迁移）不能被策略关掉；「低风险必须有核实过的测试证据」也不能。
 */
export function computeRisk(input: RiskInput, policy: ResolvedPrPolicy["risk"]): Risk & { stats: RiskStats } {
  const reasons: RiskReason[] = [];
  const stats = riskStats(input.files, policy);
  const paths = input.files.map((f) => f.path);
  let level: RiskLevel | null = null;
  const hit = (rule: RiskRule, l: RiskLevel, detail: string, files?: string[]) => {
    reasons.push({ rule, level: l, detail, ...(files && files.length ? { files: files.slice(0, 20) } : {}) });
    level = level ? max(level, l) : l;
  };

  for (const [cls, rule] of pathRule) {
    const matched = paths.filter((p) => matchAny(p, policy.paths[cls]));
    if (matched.length) hit(rule, "high", RULE_DETAIL[rule]!, matched);
  }
  if (stats.lines > policy.size.largeLines || stats.files > policy.size.largeFiles) {
    hit("large_diff", "high", `${stats.lines} lines in ${stats.files} files`);
  }
  if (input.openRepoCount >= 2) hit("multi_repo", "high", `${input.openRepoCount} repos have open PRs for this ticket`);
  const warn: string[] = [];
  if (input.ci === "failing") warn.push("CI failing");
  if (input.unresolvedHits > 0) warn.push(`${input.unresolvedHits} unresolved check hits`);
  if (input.checksAbsent) warn.push(`checks not attached: ${input.checksAbsent}`);
  if (input.mustViolations > 0) warn.push(`${input.mustViolations} must-level pre-review violations`);
  if (warn.length) hit("check_warnings", "high", warn.join("; "));
  if (input.ticketType) {
    const floor = policy.types.floors[input.ticketType];
    if (floor && floor !== "low") hit("ticket_type", floor, `ticket type ${input.ticketType}`);
  }

  if (level === null) {
    const small = stats.lines <= policy.size.smallLines && stats.files <= policy.size.smallFiles;
    const nonGenerated = input.files.filter((f) => !matchAny(f.path, policy.paths.generated));
    const lowFiles = stats.lines <= 20 || nonGenerated.every((f) => matchAny(f.path, policy.paths.lowRisk));
    const green = input.ci !== null ? input.ci === "passing" : input.rerun === "passed";
    const why: string[] = [];
    if (!small) why.push(`${stats.lines} lines in ${stats.files} files`);
    if (!lowFiles) why.push("touches non-test, non-doc files");
    if (!green) why.push(input.ci !== null ? `CI ${input.ci}` : "no passing rerun");
    if (!input.verifiedTest) why.push("no verified test output");
    if (why.length === 0) {
      reasons.push({ rule: "low", level: "low", detail: "small, low-risk change with verified tests" });
      level = "low";
    } else {
      reasons.push({ rule: "default", level: "medium", detail: why.join("; ") });
      level = "medium";
    }
  }

  if (input.evidenceGaps.length && (level as RiskLevel) !== "high") {
    const raised = up(level as RiskLevel);
    reasons.push({ rule: "missing_evidence", level: raised, detail: input.evidenceGaps.map((g) => g.category).join(", ") });
    level = raised;
  } else if (input.evidenceGaps.length) {
    reasons.push({ rule: "missing_evidence", level: "high", detail: input.evidenceGaps.map((g) => g.category).join(", ") });
  }
  return { level, reasons, stats };
}
