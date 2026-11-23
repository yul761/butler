// 预审、证据交叉核对、简报摘要的三次后台模型调用（设计 §3.4、§4.4、§8.1）。都经 A 的路由（execHeadlessJson）。
import { z } from "zod";
import { headlessArgs } from "../claude/headless";
import type { ExecOptions, HeadlessExecResult } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import type { Candidate } from "../routing/router";
import { stripModelTags } from "../util/judge-text";
import { normalizePath } from "../../shared/glob";
import type { CheckSummary, DiffFile, EvidenceItem, EvidenceVerified, Violation } from "../../shared/prereview";

export type ExecRun = (o: ExecOptions) => Promise<HeadlessExecResult>;
export type Lang = "zh" | "en";

/** 预审模型能用的工具：只读 worktree 看上下文（设计 §4.3）。 */
export const PRE_REVIEW_TOOLS = ["Read", "Grep", "Glob"] as const;

const TEXT_CHARS = 400;
const SUMMARY_CHARS = 600;
const BRIEF_SUMMARY_CHARS = 1500;
const EVIDENCE_OUTPUT_CHARS = 1500;
const DESCRIPTION_CHARS = 3000;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
/** 模型写的一段话：去掉标签、压成一行、截断。 */
const clean = (s: string, n: number): string => cut(stripModelTags(s).replace(/\s+/g, " ").trim(), n);
const failDetail = (r: HeadlessExecResult & { ok: false }): string => `${r.reason}: ${r.message}`.slice(0, 300);

// ---------------------------------------------------------------- 预审

const ViolationSchema = z.object({
  lessonId: z.number().int().nullable(),
  checkKey: z.string().nullable(),
  file: z.string(),
  line: z.number().int().nullable(),
  severity: z.enum(["must", "should"]),
  what: z.string(),
  fix: z.string(),
});
const PreReviewSchema = z.object({ violations: z.array(ViolationSchema), summary: z.string() });
const PRE_REVIEW_JSON = toCliJsonSchema(PreReviewSchema);

export interface ModelLesson {
  id: number;
  text: string;
  strength: "must" | "should" | null;
  scopeGlobs: string[];
}

export interface PreReviewModelInput {
  cwd: string;
  addDirs?: string[];
  ticketKey: string | null;
  ticketTitle: string | null;
  /** 开发 session 的模型：审查方尽量换一个（契约 4.1）。 */
  producer: Candidate | null;
  files: DiffFile[];
  /** diffForModel 的正文。 */
  diffText: string;
  lessons: ModelLesson[];
  /** 筛完、截断之前的规矩条数（> lessons.length 时写进提示）。 */
  lessonsTotal: number;
  checks: CheckSummary;
  evidence: EvidenceItem[];
  lang: Lang;
}

export type PreReviewModelResult = { ok: true; violations: Violation[]; summary: string; model: string | null } | { ok: false; detail: string };

function checksBlock(c: CheckSummary, en: boolean): string {
  const lines: string[] = [];
  if (c.absent) lines.push(en ? `Checks were not attached to the session: ${c.absent}` : `session 没挂上检查：${c.absent}`);
  for (const f of c.failing) lines.push(`- checkKey=${f.checkKey} "${f.name}" (${f.severity}, ${f.mode}) x${f.count}: ${f.files.slice(0, 20).join(", ")}`);
  if (c.ci) lines.push(`CI: ${c.ci}`);
  for (const r of c.rerun) lines.push(`${en ? "Shipherd rerun" : "Shipherd 复跑"} [${r.category}] ${r.command}: ${r.skipped ? `${en ? "no result" : "没跑出结论"} (${r.skipped})` : r.ok ? "pass" : "fail"}`);
  return lines.length ? lines.join("\n") : en ? "(no check results)" : "（没有检查结果）";
}

function evidenceBlock(items: readonly EvidenceItem[], en: boolean): string {
  if (items.length === 0) return en ? "(the session submitted no evidence)" : "（session 没交证据）";
  return items
    .map((i) => {
      const head = i.kind === "check" ? `[${i.category}] ${i.name}${i.command ? ` \`${i.command}\`` : ""} → ${i.claimed}` : `[${i.kind}] ${i.name}`;
      return `- ${head}${i.summary ? `\n  ${cut(i.summary, EVIDENCE_OUTPUT_CHARS).replace(/\n/g, "\n  ")}` : ""}`;
    })
    .join("\n");
}

export function preReviewPrompt(i: PreReviewModelInput): string {
  const en = i.lang === "en";
  const lessons = i.lessons.length
    ? i.lessons.map((l) => `- id=${l.id} [${l.strength ?? "should"}]${l.scopeGlobs.length ? ` (${l.scopeGlobs.join(", ")})` : ""}: ${l.text}`).join("\n")
    : en ? "(no confirmed rules apply to these files)" : "（没有适用于这些文件的已确认规矩）";
  const more = i.lessonsTotal > i.lessons.length ? (en ? `\n(${i.lessonsTotal - i.lessons.length} lower-ranked rules were left out.)` : `\n（另有 ${i.lessonsTotal - i.lessons.length} 条排在后面的规矩没给。）`) : "";
  const head = en
    ? [
      "You are pre-reviewing a pull request before a human sees it. Compare the change against the team's confirmed rules and the check results below, and list concrete violations.",
      "Rules:",
      "- Only report a violation of one of the rules listed below (lessonId = its id), or of a failing check listed under Check results (lessonId = null, checkKey = its checkKey). Do not invent rules or report general style opinions.",
      "- file must be one of the changed files; line is the line in the new version when you can tell, else null.",
      "- severity: must for a must rule or a blocking check, should otherwise.",
      "- what: one sentence on what is wrong; fix: one sentence on how to fix it.",
      "- You may Read, Grep and Glob the worktree for context. Do not change anything.",
      "- No violations is a fine answer. summary: one or two sentences on the overall result.",
    ]
    : [
      "你在 PR 交给人之前做预审：把这次改动和团队已确认的规矩、下面的检查结果对照，列出具体的违规。",
      "要求：",
      "- 只报下面列出的规矩（lessonId 填它的 id）或者「检查结果」里失败的检查（lessonId 填 null，checkKey 填它的 checkKey）。不要自己造规矩，不要报泛泛的风格意见。",
      "- file 必须是改动里的文件；line 是新版本里的行号，看不出来填 null。",
      "- severity：must 规矩或 block 级检查填 must，其余填 should。",
      "- what：一句话说哪里不对；fix：一句话说怎么改。",
      "- 可以用 Read、Grep、Glob 看 worktree 里的上下文，不要改任何东西。",
      "- 没有违规也是正常结论。summary：一两句话说总体结论。",
    ];
  const files = i.files.map((f) => `- ${f.path} (+${f.added} -${f.deleted})`).join("\n");
  return [
    ...head,
    "",
    `## ${en ? "Ticket" : "Ticket"}: ${i.ticketKey ?? "-"} ${i.ticketTitle ?? ""}`.trim(),
    "",
    `## ${en ? "Rules" : "规矩"}`,
    lessons + more,
    "",
    `## ${en ? "Check results" : "检查结果"}`,
    checksBlock(i.checks, en),
    "",
    `## ${en ? "Evidence the session submitted" : "session 交的证据"}`,
    evidenceBlock(i.evidence, en),
    "",
    `## ${en ? "Changed files" : "改动的文件"}`,
    files,
    "",
    `## Diff`,
    i.diffText,
    "",
    en ? "Answer as JSON: violations, summary (in English)." : "用 JSON 回答：violations、summary（用中文）。",
  ].join("\n");
}

/** 丢掉不认识的规矩、不在改动里的文件、凭空造的（两个都空的）；severity 不超过规矩 / 检查本身的级别。 */
export function filterViolations(raw: z.infer<typeof ViolationSchema>[], lessons: readonly ModelLesson[], checks: CheckSummary, files: readonly DiffFile[]): Violation[] {
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const byCheck = new Map(checks.failing.map((f) => [f.checkKey, f]));
  const changed = new Set(files.map((f) => f.path));
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const file = normalizePath(v.file.trim()).replace(/^\.\//, "");
    if (!changed.has(file)) continue;
    const lesson = v.lessonId !== null ? byId.get(v.lessonId) : undefined;
    const check = v.checkKey !== null ? byCheck.get(v.checkKey) : undefined;
    if (v.lessonId !== null && !lesson) continue;
    if (!lesson && !check) continue;
    let severity = v.severity;
    if (lesson?.strength === "should") severity = "should";
    if (!lesson && check?.severity === "warn") severity = "should";
    const what = clean(v.what, TEXT_CHARS);
    if (!what) continue;
    const line = v.line !== null && v.line > 0 ? v.line : null;
    const key = `${lesson?.id ?? ""}|${check ? v.checkKey : ""}|${file}|${line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lessonId: lesson ? lesson.id : null, checkKey: check ? v.checkKey : null, file, line, severity, what, fix: clean(v.fix, TEXT_CHARS), lessonText: lesson ? cut(lesson.text, TEXT_CHARS) : null });
  }
  return out;
}

/** 预审（任务 pre_review，reviewer）：只读工具；输出过滤后返回。失败返回原因。 */
export async function preReviewByModel(run: ExecRun, i: PreReviewModelInput): Promise<PreReviewModelResult> {
  const args = headlessArgs({ schema: PRE_REVIEW_JSON, allowedTools: [...PRE_REVIEW_TOOLS], addDirs: i.addDirs });
  const r = await run({ task: "pre_review", label: `pre-review ${i.ticketKey ?? ""}`.trim(), args, prompt: preReviewPrompt(i), cwd: i.cwd, producer: i.producer, ticketKey: i.ticketKey });
  if (!r.ok) return { ok: false, detail: failDetail(r) };
  const v = validate(PreReviewSchema, r.value);
  if (!v.ok) return { ok: false, detail: "bad_output" };
  return { ok: true, violations: filterViolations(v.value.violations, i.lessons, i.checks, i.files), summary: clean(v.value.summary, SUMMARY_CHARS), model: r.route.actualModel };
}

// ---------------------------------------------------------------- 证据交叉核对

const VerifySchema = z.object({ items: z.array(z.object({ id: z.number().int(), verdict: z.enum(["consistent", "mismatch", "unverifiable"]), reason: z.string() })) });
const VERIFY_JSON = toCliJsonSchema(VerifySchema);

export interface VerifyModelInput {
  cwd: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  producer: Candidate | null;
  /** 要核对的条目（复跑已经定了的不在里面）。 */
  items: EvidenceItem[];
  /** 复跑结果，给模型作参照。 */
  rerun: CheckSummary["rerun"];
  files: DiffFile[];
  lang: Lang;
}

export type VerifyModelResult = { ok: true; verdicts: Map<number, { verified: EvidenceVerified; detail: string }>; model: string | null } | { ok: false; detail: string };

export function verifyPrompt(i: VerifyModelInput): string {
  const en = i.lang === "en";
  const head = en
    ? [
      "A coding session submitted evidence that its work is done. Check each item against the facts below and say whether it holds up.",
      "- consistent: the item is plausible given the diff, the file list and Shipherd's reruns (e.g. claims tests were added and test files changed; output matches the claim).",
      "- mismatch: the item contradicts the facts (claims 120 tests passed but the output shows 0; claims tests were added but no test file changed; claims pass but the output shows failures).",
      "- unverifiable: there is not enough to tell.",
      "Judge only from what is given; you have no tools. reason: one short sentence.",
    ]
    : [
      "一个写代码的 session 交了「做完了」的证据。对照下面的事实逐条判断它站不站得住。",
      "- consistent：和 diff、文件清单、Shipherd 的复跑对得上（比如说加了测试，改动里确实有测试文件；输出和声称一致）。",
      "- mismatch：和事实矛盾（说 120 个测试全过，输出里是 0 个；说加了测试，改动里没有测试文件；说通过，输出里有失败）。",
      "- unverifiable：给的东西不够判断。",
      "只根据给你的内容判断，你没有工具。reason：一句短话。",
    ];
  const items = i.items
    .map((it) => `### id=${it.id} [${it.kind}${it.category ? `/${it.category}` : ""}] ${it.name}${it.command ? ` \`${it.command}\`` : ""}${it.claimed ? ` → ${it.claimed}` : ""}\n${cut(it.summary, EVIDENCE_OUTPUT_CHARS)}`)
    .join("\n\n");
  const rerun = i.rerun.length ? i.rerun.map((r) => `- [${r.category}] ${r.command}: ${r.skipped ? `no result (${r.skipped})` : r.ok ? "pass" : "fail"}`).join("\n") : en ? "(none)" : "（没有）";
  return [
    ...head,
    "",
    `Ticket: ${i.ticketKey ?? "-"} ${i.ticketTitle ?? ""}`.trim(),
    "",
    `## ${en ? "Changed files" : "改动的文件"}`,
    i.files.map((f) => `- ${f.path} (+${f.added} -${f.deleted})`).join("\n") || "-",
    "",
    `## ${en ? "Shipherd reruns" : "Shipherd 复跑"}`,
    rerun,
    "",
    `## ${en ? "Evidence items" : "证据条目"}`,
    items,
    "",
    en ? "Answer as JSON: items (id exactly as given, verdict, reason in English)." : "用 JSON 回答：items（id 照抄、verdict、reason 用中文）。",
  ].join("\n");
}

/** 交叉核对（任务 evidence_verify，reviewer）：不给工具。不认识的 id 丢掉。 */
export async function verifyEvidenceByModel(run: ExecRun, i: VerifyModelInput): Promise<VerifyModelResult> {
  if (i.items.length === 0) return { ok: true, verdicts: new Map(), model: null };
  const args = headlessArgs({ schema: VERIFY_JSON, allowedTools: [] });
  const r = await run({ task: "evidence_verify", label: `evidence verify ${i.ticketKey ?? ""}`.trim(), args, prompt: verifyPrompt(i), cwd: i.cwd, producer: i.producer, ticketKey: i.ticketKey });
  if (!r.ok) return { ok: false, detail: failDetail(r) };
  const v = validate(VerifySchema, r.value);
  if (!v.ok) return { ok: false, detail: "bad_output" };
  const ids = new Set(i.items.map((x) => x.id));
  const verdicts = new Map<number, { verified: EvidenceVerified; detail: string }>();
  for (const it of v.value.items) if (ids.has(it.id) && !verdicts.has(it.id)) verdicts.set(it.id, { verified: it.verdict, detail: clean(it.reason, TEXT_CHARS) });
  return { ok: true, verdicts, model: r.route.actualModel };
}

// ---------------------------------------------------------------- 简报的「改了什么、为什么」

const BriefSchema = z.object({ summary: z.string() });
const BRIEF_JSON = toCliJsonSchema(BriefSchema);

export interface BriefModelInput {
  cwd: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  prTitle: string | null;
  /** PR 描述（已去掉 Shipherd 的块）。 */
  description: string | null;
  files: DiffFile[];
  acceptance: { criterion: string; how: string }[];
  lang: Lang;
}

export function briefPrompt(i: BriefModelInput): string {
  const en = i.lang === "en";
  const head = en
    ? "Write the \"What changed and why\" paragraph of a review brief for this pull request: 2 to 5 sentences of plain Markdown (no headings), for a human reviewer. Say what the change does and why, based only on what is given. Do not claim anything about tests or quality."
    : "给这个 PR 的 review 简报写「改了什么、为什么」一段：2 到 5 句，普通 Markdown（不要标题），给人类 reviewer 看。只根据给的内容说这次改动做了什么、为什么做。不要评价测试或质量。";
  return [
    head,
    "",
    `Ticket: ${i.ticketKey ?? "-"} ${i.ticketTitle ?? ""}`.trim(),
    `PR: ${i.prTitle ?? "-"}`,
    "",
    en ? "## PR description" : "## PR 描述",
    i.description ? cut(i.description, DESCRIPTION_CHARS) : "-",
    "",
    en ? "## Changed files" : "## 改动的文件",
    i.files.slice(0, 200).map((f) => `- ${f.path} (+${f.added} -${f.deleted})`).join("\n") || "-",
    "",
    en ? "## Acceptance criteria and how they were met" : "## 验收条件和怎么满足的",
    i.acceptance.map((a) => `- ${a.criterion}: ${a.how}`).join("\n") || "-",
    "",
    en ? "Answer as JSON: summary (in English)." : "用 JSON 回答：summary（用中文）。",
  ].join("\n");
}

/** 简报摘要（任务 pr_brief）：不给工具；失败返回 null（调用方拼一句兜底）。 */
export async function briefSummaryByModel(run: ExecRun, i: BriefModelInput): Promise<string | null> {
  const args = headlessArgs({ schema: BRIEF_JSON, allowedTools: [] });
  const r = await run({ task: "pr_brief", label: `pr brief ${i.ticketKey ?? ""}`.trim(), args, prompt: briefPrompt(i), cwd: i.cwd, ticketKey: i.ticketKey });
  if (!r.ok) return null;
  const v = validate(BriefSchema, r.value);
  if (!v.ok) return null;
  // 不让模型的文字带进 HTML 注释（会和简报的标记块混在一起）。
  const text = cut(stripModelTags(v.value.summary).replace(/<!--|-->/g, "").trim(), BRIEF_SUMMARY_CHARS);
  return text || null;
}
