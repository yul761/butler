// 仓库现状（工作流 E2）：扫描结果、仓库档案、标记文件表、存量扫描、导出成 lint 的类型。纯数据，不引 Node 模块。
import type { CheckInput, CheckScope } from "./checks";

export const BASELINE_CATEGORIES = ["lint", "typecheck", "test", "build", "security", "format"] as const;
export type BaselineCategory = (typeof BASELINE_CATEGORIES)[number];

/** 仓库自己在哪一步跑：commit = pre-commit / lint-staged / husky pre-commit，push = pre-push，ci = CI 步骤。空 = 只配了，没接到任何一步。 */
export const REPO_STAGES = ["commit", "push", "ci"] as const;
export type RepoStage = (typeof REPO_STAGES)[number];

export type BaselineSource = "marker" | "ci" | "inferred";
export type BaselineConfidence = "high" | "medium" | "low";

export interface BaselineCheck {
  /** `<dir>|<category>|<tool>`，同一次扫描里唯一。 */
  id: string;
  /** 所属项目目录，仓库相对、用 /；"" 是根目录。 */
  dir: string;
  category: BaselineCategory;
  tool: string;
  /** 整个项目跑一遍的命令（在 dir 里执行）。 */
  command: string;
  /** 只跑一个文件的命令，含 {file}；工具不收文件参数时没有。 */
  fileCommand?: string;
  /** 只跑一个测试的命令模板（测试工具才有）。 */
  testOne?: string;
  stages: RepoStage[];
  /** 能不能只跑改过的文件。 */
  changedFiles: boolean;
  /** Shipherd 要把它当检查时放在哪一步。 */
  shipherdStage: "edit" | "push";
  source: BaselineSource;
  confidence: BaselineConfidence;
  /** 从哪儿看出来的：`path` 或 `path: 说明`。 */
  evidence: string[];
  /** 配置里开着的规则，`tool:rule` 或规则名（no-console、strict、F401）。 */
  facts: string[];
  /** 工具处理的扩展名（不带点）。 */
  exts?: string[];
}

export interface BaselineProject {
  dir: string;
  langs: string[];
  /** 命中的规则 key。 */
  markers: string[];
  /** 包管理器 / 运行方式：pnpm、npm、yarn、bun、uv、poetry、pipenv、pip、go、cargo、maven、gradle、dotnet、bundler、composer。 */
  pm?: string;
}

export interface ProfileProject {
  dir: string;
  langs: string[];
  install: string | null;
  build: string | null;
  testAll: string | null;
  testOne: string | null;
  fastest: string | null;
  lint: string | null;
  typecheck: string | null;
  /** 来自模型推断的字段名。 */
  inferred: string[];
}

/** 给 agent 看的仓库档案（7.8）。 */
export interface RepoProfile {
  projects: ProfileProject[];
  /** 目录约定（源码 / 测试目录、命名方式）。 */
  dirs: string[];
  ci: { category: BaselineCategory | "other"; command: string; dir: string }[];
  /** 已确认的教训（写 guide 时刷新）。 */
  pitfalls: string[];
}

export interface BaselineAdvice {
  dir: string;
  missing: BaselineCategory[];
}

export type BaselineStatus = "ok" | "partial" | "skipped" | "failed";
export type BaselineSkipReason = "not_cloned" | "unreadable" | "not_git" | "cancelled" | "error";
export type InferState = "none" | "ran" | "failed" | "skipped_off";

export interface RepoBaseline {
  id: number;
  slug: string;
  scannedAt: number;
  status: BaselineStatus;
  skipReason: BaselineSkipReason | null;
  /** 跳过 / 失败时的细节（错误文字）。 */
  detail: string | null;
  origin: "local" | "imported";
  projects: BaselineProject[];
  checks: BaselineCheck[];
  advice: BaselineAdvice[];
  profile: RepoProfile;
  inputs: { path: string; hash: string }[];
  listingHash: string;
  staleAt: number | null;
  inferred: InferState;
  inferDetail: string | null;
  durationMs: number;
}

/** D 判断「已被现有检查覆盖」用（设计 §4.1）。 */
export interface BaselineCoverage {
  slug: string;
  dir: string;
  check: BaselineCheck;
  via: "fact" | "concept";
  matched: string;
  strength: "strong" | "weak";
}

/** 从现有命令生成的 run_command 检查草稿。 */
export interface BaselineDraft {
  /** 对应 BaselineCheck.id。 */
  id: string;
  input: CheckInput;
  confidence: BaselineConfidence;
  /** 低置信：建之前必须有人逐条确认。 */
  needsConfirm: boolean;
  /** 已经有同命令的检查。 */
  exists: boolean;
}

// ---- 标记文件表（三层配置，设计 §3.1） ----

export interface ToolSpec {
  tool: string;
  category: BaselineCategory;
  command: string;
  fileCommand?: string;
  testOne?: string;
  exts?: string[];
}

export interface MarkerRule {
  kind: "marker";
  key: string;
  lang?: string;
  /** 让所在目录成为一个项目。 */
  project?: boolean;
  /** 文件名 glob，相对项目目录（可带子目录，如 .github/workflows/*.yml）。 */
  files: string[];
  /** 额外条件：文件里含某段文字，或 package.json 有某个依赖。 */
  requires?: { file?: string; contains?: string; dep?: string }[];
  tools?: ToolSpec[];
  /** 解析这个文件的代码（按名字引用）。 */
  extract?: string;
  install?: string;
  pm?: string;
  priority?: number;
}

export interface KeywordRule {
  kind: "keyword";
  key: string;
  category: BaselineCategory;
  tool: string;
  /** 正则源码，按命令的一段来匹配（不区分大小写）。 */
  match: string;
  fileCommand?: string;
  exts?: string[];
  priority?: number;
}

export type BaselineRule = MarkerRule | KeywordRule;

export type RuleOrigin = "builtin" | "global" | "product" | "repo";

export interface RuleRowView {
  key: string;
  rule: BaselineRule | null;
  /** 本层存的原文（编辑用）。 */
  raw: string | null;
  enabled: boolean;
  origin: RuleOrigin;
  /** 本层有覆盖。 */
  overridden: boolean;
  invalid: string | null;
}

// ---- 页面视图 ----

export interface BaselineRepoView {
  slug: string;
  path: string | null;
  latest: RepoBaseline | null;
  drafts: BaselineDraft[];
  /** 写进 session guide 的样子。 */
  profileText: string;
  running: boolean;
}

export interface BaselinesView {
  repos: BaselineRepoView[];
}

export interface BaselineSummary {
  scanned: number;
  skipped: { slug: string; reason: BaselineSkipReason; detail: string | null }[];
  byConfidence: Record<BaselineConfidence, number>;
  needBasics: string[];
  toConfirm: number;
}

export type BaselinesAction =
  | { kind: "scan"; slugs: string[]; infer: boolean; force?: boolean }
  | { kind: "cancel"; slug: string }
  | { kind: "adopt"; slug: string; ids: string[]; confirmLow: string[] }
  | { kind: "ruleSave"; scope: CheckScope; key: string; rule: string; enabled: boolean }
  | { kind: "ruleRemove"; scope: CheckScope; key: string };

export type BaselinesActResult = { ok: true; created?: number; message?: string } | { ok: false; message: string };

// ---- 存量扫描 ----

export type LegacyStatus = "running" | "done" | "cancelled" | "failed" | "truncated";

export interface LegacyViolation {
  file: string;
  line: number | null;
  snippet: string;
}

export interface LegacyScanView {
  scanId: number;
  checkKey: string;
  slug: string;
  status: LegacyStatus;
  startedAt: number;
  finishedAt: number | null;
  filesTotal: number;
  filesScanned: number;
  count: number;
  error: string | null;
}

/** 给 F（回测）的最新一次存量扫描。 */
export interface LegacyLatest {
  scanId: number;
  count: number;
  at: number;
  status: LegacyStatus;
}

export type LegacyScanResult = { ok: true; scan: LegacyScanView } | { ok: false; message: string };

export type LegacyAction = { kind: "run"; checkId: number; slug: string } | { kind: "cancel"; scanId: number };

// ---- 导出成 lint ----

export type ExportTarget = "pre_commit" | "eslint" | "lint_staged" | "husky" | "script";
export type ExportStatus = "ready" | "pushed" | "pr_opened" | "discarded" | "failed";

export interface CheckExportView {
  id: number;
  checkKey: string;
  slug: string;
  target: ExportTarget;
  branch: string;
  base: string;
  worktree: string;
  files: string[];
  diff: string;
  status: ExportStatus;
  detail: string | null;
  prUrl: string | null;
  committed: boolean;
  createdAt: number;
}

export type CheckExportAction =
  | { kind: "run"; checkKey: string; slug: string }
  | { kind: "discard"; id: number }
  | { kind: "push"; id: number }
  | { kind: "pr"; id: number }
  | { kind: "open"; id: number };

export type CheckExportResult = { ok: true; export?: CheckExportView; message?: string } | { ok: false; message: string };

export function baselineCheckId(dir: string, category: BaselineCategory, tool: string): string {
  return `${dir}|${category}|${tool}`;
}
