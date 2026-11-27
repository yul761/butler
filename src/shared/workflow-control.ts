import { NOTE_LIMIT, NOTES_LIMIT, isWorkflowStepId, parseScopeRef, type WorkflowStepId } from "./workflow";

/**
 * 工作流程的 MCP 请求（BTL-273），单独放一个文件：control.ts 只在类型和解析里各接一行。
 * - ticket session：workflow_step_done（自己标做完一步）。
 * - 两级总控：get_workflow、set_workflow、list_workflow_presets。scope 是 "global" / "product:<名字或 id>" / "repo:<owner/repo>" /
 *   "epic:<名字或 id>" / "ticket:<key>"；epic 总控不给 scope 时是它自己的 epic。
 * steps 原样带过去，主进程用 parseWorkflow 验（错了返回能读懂的原因）；null 清掉这一层。
 */
export type WorkflowTicketOp = { op: "workflow_step_done"; step: WorkflowStepId; note?: string };

export type WorkflowCoordinatorOp =
  | { op: "get_workflow"; scope?: string; ticket?: string }
  | { op: "set_workflow"; scope?: string; steps: unknown[] | null; notes?: string }
  | { op: "list_workflow_presets" };

export const WORKFLOW_STEP_NOTE_LIMIT = 500;
/** 一次 set_workflow 的 steps 最多这么多项（词表只有 10 个，重复的 parseWorkflow 会拒）。 */
const STEPS_MAX = 20;

export const isWorkflowCoordinatorOp = (op: unknown): op is WorkflowCoordinatorOp["op"] => op === "get_workflow" || op === "set_workflow" || op === "list_workflow_presets";

const okScope = (x: unknown): x is string | undefined => x === undefined || parseScopeRef(x) !== null;

export function parseWorkflowTicketOp(o: Record<string, unknown>): WorkflowTicketOp | null {
  if (o.op !== "workflow_step_done" || !isWorkflowStepId(o.step)) return null;
  if (o.note !== undefined && (typeof o.note !== "string" || o.note.length > WORKFLOW_STEP_NOTE_LIMIT)) return null;
  const note = typeof o.note === "string" && o.note.trim() ? o.note.trim() : undefined;
  return { op: "workflow_step_done", step: o.step, ...(note !== undefined && { note }) };
}

export function parseWorkflowCoordinatorOp(o: Record<string, unknown>): WorkflowCoordinatorOp | null {
  if (o.op === "list_workflow_presets") return { op: "list_workflow_presets" };
  if (!okScope(o.scope)) return null;
  const scope = typeof o.scope === "string" ? o.scope.trim() : undefined;
  if (o.op === "get_workflow") {
    if (o.ticket !== undefined && (typeof o.ticket !== "string" || !o.ticket.trim() || o.ticket.length > 200)) return null;
    if (scope !== undefined && o.ticket !== undefined) return null;
    return { op: "get_workflow", ...(scope !== undefined && { scope }), ...(typeof o.ticket === "string" && { ticket: o.ticket.trim() }) };
  }
  if (o.op === "set_workflow") {
    if (!("steps" in o)) return null;
    if (o.steps !== null && (!Array.isArray(o.steps) || o.steps.length === 0 || o.steps.length > STEPS_MAX)) return null;
    // 说明太长直接拒（不悄悄截断）；单步的 note 由 parseWorkflow 按 NOTE_LIMIT 拒。
    if (o.notes !== undefined && (typeof o.notes !== "string" || o.notes.length > NOTES_LIMIT)) return null;
    if (Array.isArray(o.steps) && JSON.stringify(o.steps).length > STEPS_MAX * (NOTE_LIMIT + 200)) return null;
    return { op: "set_workflow", ...(scope !== undefined && { scope }), steps: o.steps as unknown[] | null, ...(typeof o.notes === "string" && { notes: o.notes }) };
  }
  return null;
}
