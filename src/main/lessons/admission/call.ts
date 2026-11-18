import { createHash } from "node:crypto";
import type { z } from "zod";
import type { TaskId } from "../../../shared/model-routing";
import { headlessArgs } from "../../claude/headless";
import type { ExecOptions, HeadlessExecResult } from "../../handoff/headless-exec";
import type { Candidate } from "../../routing/router";
import { toCliJsonSchema, validate } from "../../handoff/schema";

/** 准入流水线的一次后台调用：接线处交给 execHeadlessJson（按 task 走模型路由，契约 4.1），测试里换成假的。 */
export type AdmissionRunner = (req: ExecOptions) => Promise<HeadlessExecResult>;

/** 一次调用的结果。失败时 waitUntil 不为空说明是限流 / 没有可用模型：到点再试，不算一次失败的尝试。 */
export type CallOutcome<T> =
  | { ok: true; value: T; model: string | null; degraded: boolean; sameModelReview: boolean }
  | { ok: false; reason: string; message: string; waitUntil: number | null };

export interface CallSpec<T> {
  task: TaskId;
  label: string;
  schema: z.ZodType<T>;
  prompt: string;
  cwd: string;
  /** 评审任务：产出方的模型（路由据此换一个模型或提一档）。 */
  producer?: Candidate | null;
}

/** 调一次模型并校验；onCall 在真的发起调用时数一次（向导显示「后台调用 N 次」）。 */
export async function callModel<T>(run: AdmissionRunner, spec: CallSpec<T>, onCall?: () => void): Promise<CallOutcome<T>> {
  onCall?.();
  const r = await run({
    task: spec.task,
    label: spec.label,
    args: headlessArgs({ schema: toCliJsonSchema(spec.schema), allowedTools: [] }),
    prompt: spec.prompt,
    cwd: spec.cwd,
    ...(spec.producer ? { producer: spec.producer } : {}),
  });
  if (!r.ok) {
    const limited = r.reason === "rate_limited" || r.limit !== null || r.waitUntil !== undefined;
    return { ok: false, reason: r.reason, message: r.message.slice(0, 500), waitUntil: limited ? (r.waitUntil ?? r.limit?.resetsAt ?? null) : null };
  }
  const v = validate(spec.schema, r.value);
  if (!v.ok) return { ok: false, reason: "bad_output", message: v.errors.slice(0, 500), waitUntil: null };
  return { ok: true, value: v.value, model: r.route.actualModel, degraded: r.route.degraded, sameModelReview: r.route.sameModelReview };
}

/** 判断输入的指纹：内容一样（不管键的顺序）就一样。 */
export function inputHash(v: unknown): string {
  return createHash("sha256").update(stable(v)).digest("hex").slice(0, 32);
}
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/** 按大小切块。 */
export function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += Math.max(1, size)) out.push(xs.slice(i, i + Math.max(1, size)));
  return out;
}
