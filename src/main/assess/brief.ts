// review 简报（设计 §8.1）：一页 Markdown，包在 <!-- shipherd:brief --> … <!-- /shipherd:brief --> 里。
// 只有「改了什么、为什么」那一段是模型写的；其余全是确定的数据。证据只列核实过的，session 的自述不原样进来。
import { matchAny } from "../../shared/glob";
import type { ResolvedPrPolicy } from "../../shared/pr-policy";
import { BRIEF_END, BRIEF_START, type DiffFile, type EvidenceGap, type EvidenceItem, type Risk, type RiskRule, type Violation } from "../../shared/prereview";
import { gapLine } from "../prereview/delivery";
import { CAT, type Lang } from "./readiness";

/** 「建议重点看」里按改动行数挑的文件数。 */
export const BRIEF_FOCUS_TOP = 5;
const LIST_MAX = 20;

export interface BriefInput {
  lang: Lang;
  /** 模型写的摘要；null = 模型失败，用 fallback 拼一句。 */
  summary: string | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  prTitle: string | null;
  files: DiffFile[];
  risk: Risk | null;
  evidence: EvidenceItem[];
  gaps: EvidenceGap[];
  preReview: { verdict: "clean" | "violations" | "error" | null; violations: Violation[] } | null;
  notes: string | null;
  policy: ResolvedPrPolicy["risk"];
}

const RULE = {
  en: {
    migration: "migration or schema", auth: "auth or permissions", public_api: "public API", config: "config or secrets", ci_config: "CI config",
    large_diff: "large change", multi_repo: "several repos", check_warnings: "check warnings", missing_evidence: "missing evidence",
    ticket_type: "ticket type", low: "small change with verified tests", default: "default",
  },
  zh: {
    migration: "迁移或 schema", auth: "登录或权限", public_api: "公开 API", config: "配置或密钥", ci_config: "CI 配置",
    large_diff: "改动大", multi_repo: "跨多个仓库", check_warnings: "检查有警告", missing_evidence: "缺证据",
    ticket_type: "ticket 类型", low: "改动小、测试核实过", default: "默认",
  },
} satisfies Record<Lang, Record<RiskRule, string>>;

const LEVEL = { en: { low: "low", medium: "medium", high: "high" }, zh: { low: "低", medium: "中", high: "高" } } as const;

const one = (s: string): string => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;
const lines = (f: DiffFile): number => f.added + f.deleted;

/** 模型失败时的一句：ticket 标题 + PR 标题 + 文件统计。 */
export function fallbackSummary(i: Pick<BriefInput, "lang" | "ticketKey" | "ticketTitle" | "prTitle" | "files">): string {
  const n = i.files.length;
  const add = i.files.reduce((a, f) => a + f.added, 0);
  const del = i.files.reduce((a, f) => a + f.deleted, 0);
  const what = [i.ticketKey && i.ticketTitle ? `${i.ticketKey} ${i.ticketTitle}` : (i.ticketTitle ?? i.ticketKey), i.prTitle].filter(Boolean).join(" — ");
  return i.lang === "en"
    ? `${what || "This change"}: ${n} file${n === 1 ? "" : "s"}, +${add} -${del}.`
    : `${what || "这次改动"}：${n} 个文件，+${add} -${del}。`;
}

/** 建议重点看：命中风险路径的文件，加上改动行数最多的前 5 个（生成文件除外）。 */
export function focusFiles(files: readonly DiffFile[], policy: ResolvedPrPolicy["risk"]): string[] {
  const classes = ["migration", "auth", "publicApi", "config", "ci"] as const;
  const risky = files.filter((f) => classes.some((c) => matchAny(f.path, policy.paths[c]))).map((f) => f.path);
  const top = files
    .filter((f) => !matchAny(f.path, policy.paths.generated))
    .slice()
    .sort((a, b) => lines(b) - lines(a) || (a.path < b.path ? -1 : 1))
    .slice(0, BRIEF_FOCUS_TOP)
    .map((f) => f.path);
  return [...new Set([...risky, ...top])].slice(0, LIST_MAX);
}

export function renderBrief(i: BriefInput): string {
  const en = i.lang === "en";
  const out: string[] = [BRIEF_START, en ? "## Shipherd review brief" : "## Shipherd review 简报", ""];

  // 1. 改了什么、为什么
  out.push(en ? "### What changed and why" : "### 改了什么、为什么", "", one(i.summary ?? fallbackSummary(i)), "");

  // 2. 风险
  out.push(en ? "### Risk" : "### 风险", "");
  if (!i.risk) out.push(en ? "Not assessed yet." : "还没评估。");
  else {
    out.push(en ? `**${LEVEL.en[i.risk.level]}**` : `**${LEVEL.zh[i.risk.level]}**`);
    for (const r of i.risk.reasons) {
      const files = r.files?.length ? `: ${r.files.slice(0, 5).map(code).join(", ")}${r.files.length > 5 ? (en ? ` and ${r.files.length - 5} more` : ` 等 ${r.files.length} 个`) : ""}` : "";
      out.push(`- ${RULE[i.lang][r.rule]} (${LEVEL[i.lang][r.level]})${files}`);
    }
  }
  out.push("");

  // 3. 证据（只列核实过的；不实的写对不上；缺的写缺少）
  out.push(en ? "### Evidence" : "### 证据", "");
  const ev: string[] = [];
  for (const e of i.evidence) {
    if (e.kind === "not_run") continue;
    const label = e.kind === "check" ? (e.category && e.category !== "other" ? CAT[i.lang][e.category] : one(e.name)) : one(e.name);
    if (e.verified === "rerun_pass") ev.push(en ? `- ${label}: Shipherd's rerun passed${e.verifyDetail ? ` (${code(e.verifyDetail)})` : ""}` : `- ${label}：Shipherd 复跑通过${e.verifyDetail ? `（${code(e.verifyDetail)}）` : ""}`);
    else if (e.verified === "consistent") ev.push(en ? `- ${cut(label, 120)}: output checked` : `- ${cut(label, 120)}：已核对输出`);
    else if (e.verified === "rerun_fail" || e.verified === "mismatch") ev.push(en ? `- ${cut(label, 120)}: does not match: ${cut(one(e.verifyDetail ?? ""), 200)}` : `- ${cut(label, 120)}：对不上：${cut(one(e.verifyDetail ?? ""), 200)}`);
  }
  for (const g of i.gaps) if (g.state === "missing") ev.push(`- ${gapLine({ ...g, detail: "" }, i.lang)}`);
  out.push(...(ev.length ? ev.slice(0, LIST_MAX * 2) : [en ? "No verified evidence." : "没有核实过的证据。"]), "");

  // 4. 预审结论
  out.push(en ? "### Pre-review" : "### 预审", "");
  const p = i.preReview;
  if (!p || p.verdict === null) out.push(en ? "Not run." : "没有跑。");
  else if (p.verdict === "error") out.push(en ? "Could not finish." : "没做完。");
  else if (p.violations.length === 0) out.push(en ? "Clean." : "通过。");
  else {
    out.push(en ? `${p.violations.length} finding${p.violations.length === 1 ? "" : "s"}${p.verdict === "clean" ? ", none blocking" : ""}:` : `${p.violations.length} 条${p.verdict === "clean" ? "，都不是必须改的" : ""}：`);
    for (const v of p.violations.slice(0, LIST_MAX)) out.push(`- ${code(`${v.file}${v.line !== null ? `:${v.line}` : ""}`)} ${cut(one(v.what), 200)}`);
    if (p.violations.length > LIST_MAX) out.push(en ? `- …and ${p.violations.length - LIST_MAX} more` : `- …还有 ${p.violations.length - LIST_MAX} 条`);
  }
  out.push("");

  // 5. 建议重点看
  const focus = focusFiles(i.files, i.policy);
  out.push(en ? "### Worth a close look" : "### 建议重点看", "", ...(focus.length ? focus.map((f) => `- ${code(f)}`) : ["-"]), "");

  // 6. 已知取舍和没做的事
  const skipped = i.evidence.filter((e) => e.kind === "not_run");
  if (skipped.length || i.notes) {
    out.push(en ? "### Trade-offs and what was not done" : "### 已知取舍和没做的事", "");
    for (const e of skipped.slice(0, LIST_MAX)) out.push(`- ${cut(one(e.name), 120)}${en ? ": " : "："}${cut(one(e.summary), 300)}`);
    if (i.notes) out.push(...(skipped.length ? [""] : []), cut(i.notes.trim(), 2000));
    out.push("");
  }
  out.push(BRIEF_END);
  // 自述（notes、not_run 原因、模型摘要）不能提前关掉标记块。
  const body = out.slice(1, -1).join("\n").replace(/<!--|-->/g, "");
  return `${BRIEF_START}\n${body.trim()}\n${BRIEF_END}`;
}

/** 把简报块写进 PR 描述：已有块就整块替换，没有就追加在末尾；块以外的内容原样不动。 */
export function upsertBriefBlock(body: string, block: string): string {
  const start = body.indexOf(BRIEF_START);
  const end = start >= 0 ? body.indexOf(BRIEF_END, start) : -1;
  if (start >= 0 && end >= 0) return body.slice(0, start) + block + body.slice(end + BRIEF_END.length);
  const base = body.replace(/\s+$/, "");
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}
