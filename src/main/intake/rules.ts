import { matchAny } from "../../shared/glob";
import type { IncomingTicket, IntakeMissing, IntakeReason, IntakeRisk, IntakeSize } from "../../shared/intake";
import type { ResolvedPrPolicy, RiskPathClass } from "../../shared/pr-policy";
import { inferTicketType } from "../assess/ticket-type";

/**
 * 自动接活的规则分类（设计补充 ws-n 第 3 节，规则版本 INTAKE_RULES_VERSION）。纯函数，不调模型。
 * 每一维要么判定、要么判不了（undecided 里列出来，交给 intake_classify 模型）；要不要澄清总是由规则判定。
 */
export interface RuleResult {
  size: IntakeSize | null;
  risk: IntakeRisk | null;
  clarify: boolean;
  missing: IntakeMissing[];
  expectedPaths: string[];
  reasons: IntakeReason[];
  undecided: ("size" | "risk")[];
}

const SIZE_RANK: Record<IntakeSize, number> = { small: 0, medium: 1, large: 2 };
const RISK_RANK: Record<IntakeRisk, number> = { low: 0, medium: 1, high: 2 };
export const maxSize = (a: IntakeSize, b: IntakeSize): IntakeSize => (SIZE_RANK[a] >= SIZE_RANK[b] ? a : b);
export const maxRisk = (a: IntakeRisk, b: IntakeRisk): IntakeRisk => (RISK_RANK[a] >= RISK_RANK[b] ? a : b);
export const sizeAtMost = (s: IntakeSize, cap: IntakeSize): boolean => SIZE_RANK[s] <= SIZE_RANK[cap];
export const riskAtMost = (r: IntakeRisk, cap: IntakeRisk): boolean => RISK_RANK[r] <= RISK_RANK[cap];

/** 描述去掉空白后不到这么多字符算「缺描述」（中日韩字一个算两个）。 */
export const MIN_DESCRIPTION_CHARS = 40;
const CJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g;
const textWeight = (s: string): number => {
  const compact = s.replace(/\s+/g, "");
  return compact.length + (compact.match(CJK)?.length ?? 0);
};

const BUG_TYPE = /bug|defect|incident|缺陷|故障/i;
const SMALL_TYPE = /\bdocs?\b|documentation|chore|文档|杂务/i;
const REPRO = /steps?\s+to\s+reproduce|\brepro(duce|duction|\s+steps)?\b|复现|重现|步骤|^\s*\d+[.)、]\s+\S/im;
const ACCEPTANCE = /acceptance\s+criteria|\bAC\s*[:：]|验收|\bgiven\b[\s\S]{0,300}\bwhen\b[\s\S]{0,300}\bthen\b|done\s+when|完成标准|定义完成|^\s*[-*]\s*\[[ xX]\]/im;
const HIGH_PRIORITY = /highest|blocker|critical|urgent|^p[01]$|紧急|最高/i;
const HIGH_KEYWORDS = /\b(migrations?|schema\s+changes?|auth(entication|orization)?|permissions?|security|payments?|billing|credentials?|secrets?)\b|迁移|权限|鉴权|安全|支付|计费|密钥/i;
const SMALL_LABELS = new Set(["trivial", "typo", "small", "good-first-issue", "good first issue", "xs", "s"]);
const LARGE_LABELS = new Set(["epic", "large", "xl", "l", "big"]);

const EXT = "ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|rs|swift|cs|cpp|c|h|sql|ya?ml|json|toml|md|css|scss|html|vue|svelte|proto|graphql|sh|prisma";
/** 像路径的词：含 / 的（目录或文件），或带常见扩展名的文件名。网址不算。 */
const PATH_RE = new RegExp(String.raw`(?:^|[\s\x60'"(\[])((?:[\w.@-]+/)+[\w.@-]*|[\w.-]+\.(?:${EXT}))(?=$|[\s\x60'"),.;:!?\]])`, "gim");

/** 从文字里提取预计要改的路径：统一成 /、去掉开头的 ./ 和结尾的标点，最多 50 个。 */
export function extractPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.replace(/\\/g, "/").matchAll(PATH_RE)) {
    const start = (m.index ?? 0) + m[0].indexOf(m[1]!);
    const before = text.slice(Math.max(0, start - 3), start);
    if (before.endsWith("://") || before.endsWith(":/")) continue;
    let p = m[1]!.replace(/^\.\//, "").replace(/[.,;:]+$/, "");
    if (/^[a-z]+:\/\//i.test(p) || /^www\./i.test(p) || p.includes("//")) continue;
    if (p === "" || p === "/" || /^\d+(\/\d+)*$/.test(p)) continue;
    // 日期、分数、「和/或」这类不是路径：两边都要像文件名，至少一边有字母
    if (!/[a-z]/i.test(p)) continue;
    if (p.startsWith("/")) p = p.slice(1);
    if (!out.includes(p)) out.push(p);
    if (out.length >= 50) break;
  }
  return out;
}

const HIGH_CLASSES: [RiskPathClass, string][] = [
  ["migration", "migration"], ["auth", "auth"], ["publicApi", "public_api"], ["config", "config"], ["ci", "ci_config"],
];

/** ticket 的类型：bug 类、docs / chore 类、其余（要做功能的）。 */
export function ticketKind(t: IncomingTicket, types: ResolvedPrPolicy["risk"]["types"]): { kind: "bug" | "small" | "feature"; gType: string | null } {
  const gType = inferTicketType([...t.labels, ...(t.type ? [t.type] : [])], null, types);
  if ((t.type && BUG_TYPE.test(t.type)) || gType === "bug" || gType === "hotfix") return { kind: "bug", gType };
  if ((t.type && SMALL_TYPE.test(t.type)) || gType === "docs" || gType === "chore") return { kind: "small", gType };
  return { kind: "feature", gType };
}

export function classifyByRules(t: IncomingTicket, risk: ResolvedPrPolicy["risk"]): RuleResult {
  const reasons: IntakeReason[] = [];
  const text = `${t.title}\n${t.description}`;
  const { kind, gType } = ticketKind(t, risk.types);

  // 要不要先澄清
  const missing: IntakeMissing[] = [];
  if (textWeight(t.description) < MIN_DESCRIPTION_CHARS) {
    missing.push("description");
    reasons.push({ dim: "clarify", rule: "short_description", detail: String(t.description.trim().length) });
  }
  if (kind === "bug" && !REPRO.test(t.description)) {
    missing.push("repro_steps");
    reasons.push({ dim: "clarify", rule: "no_repro", detail: t.type ?? gType ?? "bug" });
  }
  if (kind === "feature" && !ACCEPTANCE.test(t.description)) {
    missing.push("acceptance_criteria");
    reasons.push({ dim: "clarify", rule: "no_acceptance", detail: t.type ?? "" });
  }
  if (missing.length === 0) reasons.push({ dim: "clarify", rule: "complete", detail: kind });

  // 大小
  let size: IntakeSize | null = null;
  const bump = (s: IntakeSize, rule: string, detail: string) => {
    size = size ? maxSize(size, s) : s;
    reasons.push({ dim: "size", rule, detail });
  };
  if (t.storyPoints !== null) bump(t.storyPoints <= 2 ? "small" : t.storyPoints <= 5 ? "medium" : "large", "story_points", String(t.storyPoints));
  if (t.subtasks.length >= 3) bump("large", "subtasks", String(t.subtasks.length));
  for (const l of t.labels) {
    const low = l.trim().toLowerCase();
    if (SMALL_LABELS.has(low)) bump("small", "label_small", l);
    else if (LARGE_LABELS.has(low)) bump("large", "label_large", l);
  }
  if (size === null && kind === "small") bump("small", "type_small", t.type ?? gType ?? "");

  // 风险（开工前的预估）
  const expectedPaths = extractPaths(text);
  let level: IntakeRisk | null = null;
  const raise = (l: IntakeRisk, rule: string, detail: string) => {
    level = level ? maxRisk(level, l) : l;
    reasons.push({ dim: "risk", rule, detail });
  };
  for (const [cls, rule] of HIGH_CLASSES) {
    const hit = expectedPaths.filter((p) => matchAny(p, risk.paths[cls]) || matchAny(p.endsWith("/") ? `${p}x` : p, risk.paths[cls]));
    if (hit.length) raise("high", `path_${rule}`, hit.slice(0, 5).join(", "));
  }
  const kw = HIGH_KEYWORDS.exec(text);
  if (kw) raise("high", "keyword", kw[0]);
  if (gType && risk.types.floors[gType]) raise(risk.types.floors[gType]!, "type_floor", gType);
  if (t.priority && HIGH_PRIORITY.test(t.priority.trim())) raise("medium", "priority", t.priority);
  if (level === null) {
    if (kind === "small") raise("low", "type_low", t.type ?? gType ?? "");
    else if (expectedPaths.length > 0 && expectedPaths.every((p) => matchAny(p, risk.paths.lowRisk))) raise("low", "low_paths", expectedPaths.slice(0, 5).join(", "));
  }
  if (expectedPaths.length) reasons.push({ dim: "paths", rule: "from_text", detail: expectedPaths.slice(0, 10).join(", ") });

  const undecided: ("size" | "risk")[] = [];
  if (size === null) {
    undecided.push("size");
    reasons.push({ dim: "size", rule: "no_signal", detail: "" });
  }
  if (level === null) {
    undecided.push("risk");
    reasons.push({ dim: "risk", rule: "no_signal", detail: "" });
  }
  return { size, risk: level, clarify: missing.length > 0, missing, expectedPaths, reasons, undecided };
}

const QUESTIONS: Record<"zh" | "en", Record<IntakeMissing, string>> = {
  zh: {
    description: "能补充一下描述吗：要改什么、为什么、影响到谁？",
    repro_steps: "能给一下复现步骤吗：怎么操作、期望看到什么、实际看到什么？",
    acceptance_criteria: "做到什么程度算完成？请列一下验收标准。",
  },
  en: {
    description: "Could you add a description: what should change, why, and who it affects?",
    repro_steps: "Could you add steps to reproduce: what you did, what you expected, and what happened?",
    acceptance_criteria: "What does done look like? Please list the acceptance criteria.",
  },
};

/** 缺什么就问什么（模板，不调模型）。 */
export function clarifyQuestions(missing: readonly IntakeMissing[], lang: "zh" | "en"): string[] {
  return missing.map((m) => QUESTIONS[lang][m]);
}
