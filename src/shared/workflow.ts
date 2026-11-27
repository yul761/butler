/**
 * 可配的工作流程（BTL-273）：一个 ticket 从写完到合并要走的有序步骤。纯数据和纯函数，主进程、渲染进程、MCP server 共用。
 *
 * - 步骤从固定词表里选，每步可以带一段自由文字的要求（note）和少量选项。
 * - 分层：全局（用户个人）→ 产品 → 仓库 → epic → 单个 ticket，下层整份覆盖上层（不逐步合并）。
 * - 没有任何一层设过流程：没有流程，Shipherd 的行为和以前一样。
 * - 流程决定这个 ticket 走哪些步骤；自动化档位只当总开关：决定对外动作（请求 bot review）由 Shipherd 自己做还是让 session 做。
 */

export const WORKFLOW_STEPS = [
  "implement",
  "self_review",
  "pre_review",
  "open_pr",
  "ci_green",
  "bot_review",
  "address_comments",
  "re_review",
  "human_review",
  "merge",
] as const;
export type WorkflowStepId = (typeof WORKFLOW_STEPS)[number];

export const isWorkflowStepId = (v: unknown): v is WorkflowStepId => typeof v === "string" && (WORKFLOW_STEPS as readonly string[]).includes(v);

export const REVIEW_BOTS = ["copilot", "codex"] as const;
export type ReviewBot = (typeof REVIEW_BOTS)[number];

export const MERGE_BY = ["coordinator", "user"] as const;
export type MergeBy = (typeof MERGE_BY)[number];

export interface WorkflowStep {
  id: WorkflowStepId;
  /** 这一步的要求（自由文字），原样写进 session guide 和提醒。 */
  note?: string;
  /** open_pr：先开 draft。 */
  draft?: boolean;
  /** bot_review / re_review：请谁 review。缺省 copilot。 */
  bot?: ReviewBot;
  /** re_review：最多再请几轮（1–5），缺省 2。 */
  maxRounds?: number;
  /** merge：谁来合。缺省 coordinator（总控在 CI 全绿、意见处理完以后合）。 */
  mergeBy?: MergeBy;
}

export interface Workflow {
  steps: WorkflowStep[];
  /** 整个流程的补充说明。 */
  notes: string;
}

/** 分层的哪一层。product 用 id，repo 用 slug，feature（界面上叫 epic）用 id，ticket 用 key。 */
export type WorkflowScope =
  | { kind: "global" }
  | { kind: "product"; productId: number }
  | { kind: "repo"; slug: string }
  | { kind: "feature"; featureId: number }
  | { kind: "ticket"; ticketKey: string };
export type WorkflowScopeKind = WorkflowScope["kind"];
export const WORKFLOW_SCOPE_KINDS: readonly WorkflowScopeKind[] = ["global", "product", "repo", "feature", "ticket"];

export const sameWorkflowScope = (a: WorkflowScope, b: WorkflowScope): boolean => scopeKey(a) === scopeKey(b);

/** 一层的唯一键（日志、去重用）。 */
export function scopeKey(s: WorkflowScope): string {
  switch (s.kind) {
    case "global":
      return "global";
    case "product":
      return `product:${s.productId}`;
    case "repo":
      return `repo:${s.slug.toLowerCase()}`;
    case "feature":
      return `feature:${s.featureId}`;
    case "ticket":
      return `ticket:${s.ticketKey}`;
  }
}

export const NOTE_LIMIT = 2000;
export const NOTES_LIMIT = 4000;
export const RE_REVIEW_DEFAULT_ROUNDS = 2;
export const RE_REVIEW_MAX_ROUNDS = 5;

export const WORKFLOW_PRESETS = ["fast", "strict"] as const;
export type WorkflowPresetId = (typeof WORKFLOW_PRESETS)[number];
export const isWorkflowPresetId = (v: unknown): v is WorkflowPresetId => typeof v === "string" && (WORKFLOW_PRESETS as readonly string[]).includes(v);

/**
 * 内置预设。fast：写完 → 开 PR → CI 绿 → 总控合并。strict：用户描述的上班流程：写完、自审、预审、开 PR、CI 绿、Copilot review、
 * 处理评论、有必要再请一次 Copilot（最多两轮），最后由用户自己合。
 */
export const WORKFLOW_PRESET_STEPS: Record<WorkflowPresetId, WorkflowStep[]> = {
  fast: [{ id: "implement" }, { id: "open_pr" }, { id: "ci_green" }, { id: "merge", mergeBy: "coordinator" }],
  strict: [
    { id: "implement" },
    { id: "self_review" },
    { id: "pre_review" },
    { id: "open_pr" },
    { id: "ci_green" },
    { id: "bot_review", bot: "copilot" },
    { id: "address_comments" },
    { id: "re_review", bot: "copilot", maxRounds: RE_REVIEW_DEFAULT_ROUNDS },
    { id: "merge", mergeBy: "user" },
  ],
};

export const presetWorkflow = (id: WorkflowPresetId): Workflow => ({ steps: structuredClone(WORKFLOW_PRESET_STEPS[id]), notes: "" });

/** 要 PR 已经开了才谈得上的步骤：必须排在 open_pr 后面。 */
const AFTER_PR: readonly WorkflowStepId[] = ["ci_green", "bot_review", "address_comments", "re_review", "human_review", "merge"];
/** 只能在开 PR 之前做的步骤。 */
const BEFORE_PR: readonly WorkflowStepId[] = ["implement"];

export type WorkflowProblem =
  | { code: "empty" }
  | { code: "unknown_step"; step: string }
  | { code: "duplicate"; step: WorkflowStepId }
  | { code: "needs_pr"; step: WorkflowStepId }
  | { code: "before_pr"; step: WorkflowStepId }
  | { code: "merge_last" }
  | { code: "re_review_needs_bot" }
  | { code: "bad_option"; step: WorkflowStepId; option: string }
  | { code: "too_long"; step: WorkflowStepId | null };

/**
 * 从不可信的输入（MCP、IPC、库里存的 JSON）解析一个流程。合规返回 { ok: true, workflow }（规整过：去掉空的 note、不认识的键）；
 * 不合规返回第一个问题。
 */
export function parseWorkflow(raw: unknown): { ok: true; workflow: Workflow } | { ok: false; problem: WorkflowProblem } {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, problem: { code: "empty" } };
  const notesRaw = o.notes ?? "";
  if (typeof notesRaw !== "string") return { ok: false, problem: { code: "too_long", step: null } };
  if (notesRaw.length > NOTES_LIMIT) return { ok: false, problem: { code: "too_long", step: null } };
  if (!Array.isArray(o.steps) || o.steps.length === 0) return { ok: false, problem: { code: "empty" } };
  const steps: WorkflowStep[] = [];
  for (const s of o.steps as unknown[]) {
    const r = parseStep(s);
    if (!r.ok) return r;
    if (steps.some((x) => x.id === r.step.id)) return { ok: false, problem: { code: "duplicate", step: r.step.id } };
    steps.push(r.step);
  }
  const problem = orderProblem(steps);
  if (problem) return { ok: false, problem };
  return { ok: true, workflow: { steps, notes: notesRaw.trim() } };
}

function parseStep(raw: unknown): { ok: true; step: WorkflowStep } | { ok: false; problem: WorkflowProblem } {
  // 只写一个步骤名也行（"open_pr"）。
  const o = (typeof raw === "string" ? { id: raw } : raw) as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, problem: { code: "unknown_step", step: String(raw) } };
  if (!isWorkflowStepId(o.id)) return { ok: false, problem: { code: "unknown_step", step: String(o.id) } };
  const id = o.id;
  const step: WorkflowStep = { id };
  const bad = (option: string) => ({ ok: false as const, problem: { code: "bad_option" as const, step: id, option } });
  if (o.note !== undefined && o.note !== null) {
    if (typeof o.note !== "string") return bad("note");
    if (o.note.length > NOTE_LIMIT) return { ok: false, problem: { code: "too_long", step: id } };
    if (o.note.trim()) step.note = o.note.trim();
  }
  if (o.draft !== undefined && o.draft !== null) {
    if (id !== "open_pr" || typeof o.draft !== "boolean") return bad("draft");
    if (o.draft) step.draft = true;
  }
  if (o.bot !== undefined && o.bot !== null) {
    if ((id !== "bot_review" && id !== "re_review") || !(REVIEW_BOTS as readonly unknown[]).includes(o.bot)) return bad("bot");
    step.bot = o.bot as ReviewBot;
  }
  if (o.maxRounds !== undefined && o.maxRounds !== null) {
    if (id !== "re_review" || !Number.isInteger(o.maxRounds) || (o.maxRounds as number) < 1 || (o.maxRounds as number) > RE_REVIEW_MAX_ROUNDS) return bad("maxRounds");
    step.maxRounds = o.maxRounds as number;
  }
  if (o.mergeBy !== undefined && o.mergeBy !== null) {
    if (id !== "merge" || !(MERGE_BY as readonly unknown[]).includes(o.mergeBy)) return bad("mergeBy");
    step.mergeBy = o.mergeBy as MergeBy;
  }
  return { ok: true, step };
}

function orderProblem(steps: WorkflowStep[]): WorkflowProblem | null {
  const at = (id: WorkflowStepId) => steps.findIndex((s) => s.id === id);
  const pr = at("open_pr");
  for (const [i, s] of steps.entries()) {
    if (AFTER_PR.includes(s.id) && (pr < 0 || i < pr)) return { code: "needs_pr", step: s.id };
    if (BEFORE_PR.includes(s.id) && pr >= 0 && i > pr) return { code: "before_pr", step: s.id };
  }
  const merge = at("merge");
  if (merge >= 0 && merge !== steps.length - 1) return { code: "merge_last" };
  const re = at("re_review");
  if (re >= 0) {
    const bot = at("bot_review");
    if (bot < 0 || bot > re) return { code: "re_review_needs_bot" };
  }
  return null;
}

/** 两份流程是不是同一份（比较规整过的形式）。 */
export function sameWorkflow(a: Workflow | null, b: Workflow | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 这份流程是不是某个预设（不带要求文字的那种）；不是返回 null。 */
export function presetOf(w: Workflow): WorkflowPresetId | null {
  for (const p of WORKFLOW_PRESETS) if (sameWorkflow(w, presetWorkflow(p))) return p;
  return null;
}

export const stepOf = (w: Workflow, id: WorkflowStepId): WorkflowStep | null => w.steps.find((s) => s.id === id) ?? null;
export const hasStep = (w: Workflow | null, id: WorkflowStepId): boolean => w !== null && w.steps.some((s) => s.id === id);

/** 流程里谁来合：没有 merge 步当作用户自己合（流程没把合并交给 Shipherd 管的 session）。 */
export const mergeByOf = (w: Workflow): MergeBy => stepOf(w, "merge")?.mergeBy ?? (hasStep(w, "merge") ? "coordinator" : "user");

export const botOf = (s: WorkflowStep | null): ReviewBot => s?.bot ?? "copilot";
export const maxRoundsOf = (s: WorkflowStep | null): number => s?.maxRounds ?? RE_REVIEW_DEFAULT_ROUNDS;

/** 有了流程以后，评论要不要转给 session：流程里有 bot review、处理评论、人工 review 任何一步就要。 */
export const workflowWantsComments = (w: Workflow | null): boolean =>
  w !== null && w.steps.some((s) => s.id === "bot_review" || s.id === "address_comments" || s.id === "re_review" || s.id === "human_review");

// ------------------------------------------------------------------ 进度

export type WorkflowStepState = "done" | "current" | "todo";

export interface WorkflowStepProgress {
  id: WorkflowStepId;
  state: WorkflowStepState;
  /** 完成的时间；没完成为 null。 */
  doneAt: number | null;
  /** 完成时记的一句（预审 id、PR 号、session 自己写的说明……）。 */
  detail: string | null;
  /** bot_review / re_review：已经请过几轮。 */
  rounds?: number;
}

/** 一层流程（编辑器、get_workflow 用）。 */
export interface WorkflowLayerView {
  scope: WorkflowScope;
  /** 产品名、仓库 slug、epic 名、ticket 号；全局为空串。 */
  label: string;
  workflow: Workflow;
  updatedAt: number;
}

export interface TicketWorkflowView {
  ticketKey: string;
  /** null：没有流程（照旧）。 */
  workflow: Workflow | null;
  /** 生效的那一层；没有流程为 null。 */
  source: { scope: WorkflowScope; label: string } | null;
  preset: WorkflowPresetId | null;
  steps: WorkflowStepProgress[];
  /** 当前这一步；都做完了为 null。 */
  current: WorkflowStepId | null;
}

/** 按已完成的步骤算每一步的状态：第一个没完成的是当前步。 */
export function progressOf(w: Workflow, done: ReadonlyMap<WorkflowStepId, { at: number; detail: string | null }>, rounds: Partial<Record<WorkflowStepId, number>> = {}): {
  steps: WorkflowStepProgress[];
  current: WorkflowStepId | null;
} {
  let current: WorkflowStepId | null = null;
  const steps = w.steps.map((s): WorkflowStepProgress => {
    const d = done.get(s.id);
    let state: WorkflowStepState;
    if (d) state = "done";
    else if (current === null) {
      current = s.id;
      state = "current";
    } else state = "todo";
    const p: WorkflowStepProgress = { id: s.id, state, doneAt: d?.at ?? null, detail: d?.detail ?? null };
    if (rounds[s.id] !== undefined) p.rounds = rounds[s.id];
    return p;
  });
  return { steps, current };
}

/** 一个步骤前面还没完成的步骤（闸门用）。 */
/** 流程里 a 排在 b 前面（两步都在）。 */
export function stepBefore(w: Workflow, a: WorkflowStepId, b: WorkflowStepId): boolean {
  const i = w.steps.findIndex((s) => s.id === a);
  const j = w.steps.findIndex((s) => s.id === b);
  return i >= 0 && j >= 0 && i < j;
}

/**
 * 开 PR 要不要先过预审：预审排在开 PR 前面才要。开 PR 的提醒和 gh pr create 的闸门都用它（排在后面的预审是对 PR 做的，开 PR 时不查）。
 */
export const preReviewGatesPr = (w: Workflow): boolean => stepBefore(w, "pre_review", "open_pr");

export function pendingBefore(w: Workflow, step: WorkflowStepId, done: ReadonlySet<WorkflowStepId>): WorkflowStepId[] {
  const i = w.steps.findIndex((s) => s.id === step);
  const before = i < 0 ? w.steps : w.steps.slice(0, i);
  return before.map((s) => s.id).filter((id) => !done.has(id));
}

// ------------------------------------------------------------------ 作用域的文字写法（MCP 用）

/**
 * MCP 工具里的作用域写法：global、product:<名字或 id>、repo:<owner/name>、epic:<名字或 id>、ticket:<号>。
 * 只解析写法，名字是否存在由主进程查。
 */
export type WorkflowScopeRef =
  | { kind: "global" }
  | { kind: "product"; ref: string }
  | { kind: "repo"; ref: string }
  | { kind: "feature"; ref: string }
  | { kind: "ticket"; ref: string };

export function parseScopeRef(raw: unknown): WorkflowScopeRef | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 500) return null;
  if (s.toLowerCase() === "global") return { kind: "global" };
  const i = s.indexOf(":");
  if (i < 0) return null;
  const head = s.slice(0, i).trim().toLowerCase();
  const ref = s.slice(i + 1).trim();
  if (!ref) return null;
  if (head === "product") return { kind: "product", ref };
  if (head === "repo") return { kind: "repo", ref };
  if (head === "epic" || head === "feature") return { kind: "feature", ref };
  if (head === "ticket") return { kind: "ticket", ref };
  return null;
}

// ------------------------------------------------------------------ 界面（BTL-273）

/** IPC 传进来的作用域（不可信）。repo 的 slug 统一小写。 */
export function parseWorkflowScope(raw: unknown): WorkflowScope | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const id = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
  switch (o.kind) {
    case "global":
      return { kind: "global" };
    case "product":
      return id(o.productId) ? { kind: "product", productId: o.productId } : null;
    case "repo":
      return typeof o.slug === "string" && /^[^/\s]+\/[^/\s]+(\/[^/\s]+)?$/.test(o.slug) ? { kind: "repo", slug: o.slug.toLowerCase() } : null;
    case "feature":
      return id(o.featureId) ? { kind: "feature", featureId: o.featureId } : null;
    case "ticket":
      return typeof o.ticketKey === "string" && o.ticketKey.trim() !== "" && o.ticketKey.length <= 200 ? { kind: "ticket", ticketKey: o.ticketKey.trim() } : null;
    default:
      return null;
  }
}

/** 设置 › 工作流程：设过的各层，和新建一层时能选的目标。 */
export interface WorkflowSettingsView {
  layers: WorkflowLayerView[];
  targets: {
    products: { id: number; name: string }[];
    /** 进行中 ticket 用到的仓库 slug。 */
    repos: string[];
    features: { id: number; name: string }[];
    tickets: { key: string; title: string | null }[];
  };
}

/** 一个 ticket 在流程里走到哪（epic 页的列表）。 */
export interface WorkflowTicketSummary {
  key: string;
  current: WorkflowStepId | null;
  done: number;
  total: number;
}

/** epic 页的流程条：epic 自己设的那层（没设为 null），和每个 ticket 走到哪（没流程的不列）。 */
export interface FeatureWorkflowView {
  featureId: number;
  own: Workflow | null;
  tickets: WorkflowTicketSummary[];
}

/** 改一层的结果（界面显示 message）。 */
export type WorkflowSetResult = { ok: true; changed: boolean } | { ok: false; message: string };
