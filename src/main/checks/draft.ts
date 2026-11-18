import { existsSync } from "node:fs";
import { z } from "zod";
import { headlessArgs } from "../claude/headless";
import type { HeadlessExecResult } from "../handoff/headless-exec";
import { toCliJsonSchema, validate } from "../handoff/schema";
import type { LessonsRepo } from "../db/lessons-repo";
import { M } from "../strings";
import { CHECK_SEVERITIES, CHECK_TYPES, validateCheckInput, type CheckDraftResult, type CheckInput, type CheckScope } from "../../shared/checks";
import type { ChecksService } from "./checks-service";

/** generate() 的结果：草稿或「只能是文字」，加上实际用的模型；失败时带限流的恢复时间。 */
export type DraftGeneration =
  | { ok: true; kind: "draft"; draft: CheckInput; scope: CheckScope; reason: string; model: string | null; degraded: boolean }
  | { ok: true; kind: "prose"; reason: string; model: string | null; degraded: boolean }
  | { ok: false; reason: string; message: string; waitUntil: number | null };

/**
 * 跑一次 check_draft（契约 4.1 的任务 id）：接线处交给 execHeadlessJson，按 task 走模型路由。
 */
export type CheckDraftRunner = (req: { task: "check_draft"; label: string; args: string[]; prompt: string; cwd: string }) => Promise<HeadlessExecResult>;

/** 模型的回答：能不能写成检查、理由、能的话一条检查。参数把四种类型的字段都列出来（都可选），结构化输出更稳。 */
export const CheckDraftSchema = z.object({
  checkable: z.boolean(),
  reason: z.string().max(2000),
  check: z
    .object({
      type: z.enum(CHECK_TYPES),
      name: z.string().max(200),
      params: z.object({
        pattern: z.string().optional(),
        flags: z.string().optional(),
        literal: z.boolean().optional(),
        forbid: z.array(z.string()).optional(),
        allow: z.array(z.string()).optional(),
        keywords: z.array(z.string()).optional(),
        ticketPattern: z.string().optional(),
        command: z.string().optional(),
        stage: z.enum(["edit", "push"]).optional(),
        timeoutMs: z.number().optional(),
      }),
      globs: z.array(z.string()).max(50),
      excludeGlobs: z.array(z.string()).max(50).optional(),
      severity: z.enum(CHECK_SEVERITIES),
      message: z.string().max(2000),
    })
    .optional(),
});
export const CHECK_DRAFT_JSON_SCHEMA = toCliJsonSchema(CheckDraftSchema);

/** 草稿只读仓库：读文件、搜索，不给命令。 */
const DRAFT_TOOLS = ["Read", "Grep", "Glob"];

export interface CheckDrafterDeps {
  lessons: LessonsRepo;
  checks: ChecksService;
  run: CheckDraftRunner;
  /** 没有本地仓库时的工作目录。 */
  fallbackCwd: () => string;
}

/** 从一条规矩生成检查草稿（addendum 第 8 节、决定 8）：草稿交给表单，用户按保存才落库；模型说不能检查时把规矩标成 prose（一个批次）。 */
export class CheckDrafter {
  private readonly inflight = new Map<number, Promise<CheckDraftResult>>();

  constructor(private readonly d: CheckDrafterDeps) {}

  draft(lessonId: number): Promise<CheckDraftResult> {
    const running = this.inflight.get(lessonId);
    if (running) return running;
    const p = this.run(lessonId).finally(() => this.inflight.delete(lessonId));
    this.inflight.set(lessonId, p);
    return p;
  }

  private async run(lessonId: number): Promise<CheckDraftResult> {
    const g = await this.generate(lessonId);
    if (!g.ok) return g.reason === "not_found" ? { ok: false, reason: "not_found" } : { ok: false, reason: g.reason, message: g.message };
    if (g.kind === "prose") {
      const c = this.d.checks.classifyLesson(lessonId, "prose", { reason: g.reason });
      return { ok: true, kind: "prose", reason: g.reason, batchId: c.ok ? c.batchId : null };
    }
    return { ok: true, kind: "draft", draft: g.draft, scope: g.scope, reason: g.reason };
  }

  /**
   * 只问模型、不写任何东西：规矩准入（工作流 D）在评审时生成草稿，等用户接受汇总时才和确认一起写进同一个批次。
   * 失败时 waitUntil 不为空说明是限流，到点再试。
   */
  async generate(lessonId: number): Promise<DraftGeneration> {
    const l = this.d.lessons.get(lessonId);
    if (!l) return { ok: false, reason: "not_found", message: "", waitUntil: null };
    const scope: CheckScope = l.scope.kind === "repo" ? { kind: "repo", slug: l.scope.slug } : { kind: "product", productId: l.scope.productId };
    const slug = l.scope.kind === "repo" ? l.scope.slug : (this.d.lessons.product(l.scope.productId)?.slugs[0] ?? null);
    const local = slug ? this.d.lessons.repo(slug)?.localPath : undefined;
    const cwd = local && existsSync(local) ? local : this.d.fallbackCwd();
    const repoLabel = local && existsSync(local) ? slug : null;
    const r = await this.d.run({
      task: "check_draft",
      label: "check draft",
      args: headlessArgs({ schema: CHECK_DRAFT_JSON_SCHEMA, allowedTools: repoLabel ? DRAFT_TOOLS : [] }),
      prompt: M().checks.draftPrompt(l.text, l.why, l.scopeGlobs, repoLabel),
      cwd,
    });
    if (!r.ok) {
      const limited = r.reason === "rate_limited" || r.limit !== null || r.waitUntil !== undefined;
      return { ok: false, reason: r.reason, message: r.message.slice(0, 500), waitUntil: limited ? (r.waitUntil ?? r.limit?.resetsAt ?? null) : null };
    }
    const v = validate(CheckDraftSchema, r.value);
    if (!v.ok) return { ok: false, reason: "bad_output", message: v.errors.slice(0, 500), waitUntil: null };
    const reason = v.value.reason.trim();
    const meta = { model: r.route.actualModel, degraded: r.route.degraded };
    if (!v.value.checkable || !v.value.check) return { ok: true, kind: "prose", reason, ...meta };
    const c = v.value.check;
    // 生成的检查一律先试运行：要证明自己再强制（决定 8）。
    const input = validateCheckInput({ ...c, excludeGlobs: c.excludeGlobs ?? [], mode: "shadow", enabled: true });
    if (!input.ok) return { ok: false, reason: "bad_output", message: input.error, waitUntil: null };
    return { ok: true, kind: "draft", draft: input.value, scope, reason, ...meta };
  }
}
