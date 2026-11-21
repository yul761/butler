// 自动接活的两次后台模型调用（设计补充 ws-n 第 2、3 节）：intake_classify 给规则判不了的维度分类；intake_fetch 用用户的 tracker MCP 拉 ticket。
// 都经 A 的路由（execHeadlessJson），不写死模型。
import { z } from "zod";
import { headlessArgs } from "../claude/headless";
import { toCliJsonSchema, validate } from "../handoff/schema";
import type { ExecRun } from "../prereview/model";
import { stripModelTags } from "../util/judge-text";
import { normalizePath } from "../../shared/glob";
import { INTAKE_RISKS, INTAKE_SIZES, type IncomingTicket, type IntakeRisk, type IntakeSize } from "../../shared/intake";

const DESCRIPTION_CHARS = 4000;
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const clean = (s: string, n: number): string => cut(stripModelTags(s).replace(/\s+/g, " ").trim(), n);

// ---------------------------------------------------------------- 分类

const ClassifySchema = z.object({
  size: z.enum(INTAKE_SIZES),
  risk: z.enum(INTAKE_RISKS),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  expectedPaths: z.array(z.string()),
});
const CLASSIFY_JSON = toCliJsonSchema(ClassifySchema);

export interface ModelClassification {
  size: IntakeSize;
  risk: IntakeRisk;
  confidence: number;
  reasons: string[];
  expectedPaths: string[];
  model: string | null;
}

export function classifyPrompt(t: IncomingTicket, decided: { size: IntakeSize | null; risk: IntakeRisk | null }, lang: "zh" | "en"): string {
  const en = lang === "en";
  const meta = [
    `key: ${t.key}`,
    t.type ? `type: ${t.type}` : null,
    t.labels.length ? `labels: ${t.labels.join(", ")}` : null,
    t.priority ? `priority: ${t.priority}` : null,
    t.storyPoints !== null ? `story points: ${t.storyPoints}` : null,
    t.components.length ? `components: ${t.components.join(", ")}` : null,
    t.subtasks.length ? `subtasks: ${t.subtasks.map((s) => s.title).join("; ")}` : null,
  ].filter(Boolean).join("\n");
  const known = [decided.size ? `size=${decided.size}` : null, decided.risk ? `risk=${decided.risk}` : null].filter(Boolean).join(", ");
  const head = en
    ? [
      "You are sizing a ticket before a coding agent starts on it. You can read the repository (Read, Grep, Glob) to see what the change would touch.",
      "- size: small (one focused change, under an hour), medium (a few files, a few hours), large (many files or several steps, a day or more).",
      "- risk: high if it touches database migrations, auth or permissions, public APIs, secrets or config, CI, payments; medium for core logic or wide changes; low for docs, tests, copy, isolated UI.",
      "- confidence: 0 to 1, how sure you are of both.",
      "- expectedPaths: repository-relative files or directories the change will most likely touch (at most 20).",
      "- reasons: one short sentence each.",
      known ? `The rules already decided ${known}; keep those values.` : "",
    ]
    : [
      "你在一个写代码的 agent 开工前给 ticket 估大小和风险。可以读仓库（Read、Grep、Glob）看这个改动会碰到哪些地方。",
      "- size：small（一处集中的改动，一小时内）、medium（几个文件，几小时）、large（很多文件或要分几步，一天以上）。",
      "- risk：碰数据库迁移、鉴权权限、公开 API、密钥配置、CI、支付的是 high；核心逻辑或改动面广的是 medium；文档、测试、文案、独立的 UI 是 low。",
      "- confidence：0 到 1，两项都有多大把握。",
      "- expectedPaths：最可能改到的文件或目录，相对仓库根（最多 20 个）。",
      "- reasons：每条一句短话。",
      known ? `规则已经判了 ${known}，保持这些值。` : "",
    ];
  return [...head, "", meta, "", `# ${t.title}`, cut(t.description, DESCRIPTION_CHARS), "", en ? "Answer as JSON." : "用 JSON 回答，理由用中文。"].join("\n");
}

/** 模型分类（任务 intake_classify）：失败或输出不合规返回 null。规则已判的维度以规则为准。 */
export async function classifyByModel(
  exec: ExecRun, cwd: string, t: IncomingTicket, decided: { size: IntakeSize | null; risk: IntakeRisk | null }, lang: "zh" | "en",
): Promise<ModelClassification | null> {
  const args = headlessArgs({ schema: CLASSIFY_JSON, allowedTools: ["Read", "Grep", "Glob"] });
  const r = await exec({ task: "intake_classify", label: "intake classify", args, prompt: classifyPrompt(t, decided, lang), cwd });
  if (!r.ok) return null;
  const v = validate(ClassifySchema, r.value);
  if (!v.ok) return null;
  const paths = [...new Set(v.value.expectedPaths.map((p) => normalizePath(p.trim()).replace(/^\.\//, "").replace(/^\/+/, "")).filter((p) => p && !p.includes("..")))].slice(0, 20);
  return {
    size: decided.size ?? v.value.size,
    risk: decided.risk ?? v.value.risk,
    confidence: v.value.confidence,
    reasons: v.value.reasons.map((x) => clean(x, 300)).filter(Boolean).slice(0, 8),
    expectedPaths: paths,
    model: r.route.actualModel,
  };
}

// ---------------------------------------------------------------- 从 tracker 拉

const FetchTicket = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  type: z.string().nullable(),
  labels: z.array(z.string()),
  priority: z.string().nullable(),
  url: z.string().nullable(),
  storyPoints: z.number().nullable(),
  components: z.array(z.string()),
  subtasks: z.array(z.object({ key: z.string(), title: z.string() })),
  /** 父 epic（BTL-246 §7）；没有为 null。 */
  epic: z.object({ key: z.string(), title: z.string() }).nullable().optional(),
});
const FetchSchema = z.object({ tickets: z.array(FetchTicket) });
const FETCH_JSON = toCliJsonSchema(FetchSchema);

export function fetchPrompt(query: string, lang: "zh" | "en"): string {
  return lang === "en"
    ? [
      "Use the issue tracker tools you have to list the tickets that match this query. Only read; never comment, assign or change status.",
      `Query: ${query}`,
      "For each ticket return key, title, the full description as plain text, type, labels, priority, url, story points (null if none), components, subtasks (key and title) and its parent epic (key and title; null if it has none).",
      "Return at most 30 tickets. Answer as JSON.",
    ].join("\n")
    : [
      "用你有的 tracker 工具列出符合这个查询的 ticket。只读：不要评论、不要分配、不要改状态。",
      `查询：${query}`,
      "每个 ticket 给出 key、标题、完整描述（纯文本）、类型、标签、优先级、链接、故事点（没有为 null）、组件、子任务（key 和标题）和它的父 epic（parent epic：key 和标题，没有为 null）。",
      "最多 30 个。用 JSON 回答。",
    ].join("\n");
}

export type FetchResult = { ok: true; tickets: unknown[] } | { ok: false; message: string };

/** 用 tracker MCP 拉 ticket（任务 intake_fetch）：只给用户配的 tracker 工具（只读）。 */
export async function fetchFromTracker(exec: ExecRun, cwd: string, query: string, tools: readonly string[], lang: "zh" | "en"): Promise<FetchResult> {
  if (tools.length === 0) return { ok: false, message: "no tracker tools" };
  const args = headlessArgs({ schema: FETCH_JSON, allowedTools: [...tools] });
  const r = await exec({ task: "intake_fetch", label: "intake fetch", args, prompt: fetchPrompt(query, lang), cwd });
  if (!r.ok) return { ok: false, message: `${r.reason}: ${r.message}`.slice(0, 300) };
  const v = validate(FetchSchema, r.value);
  if (!v.ok) return { ok: false, message: "bad output" };
  return { ok: true, tickets: v.value.tickets };
}
