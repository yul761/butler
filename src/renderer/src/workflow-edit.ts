import { WORKFLOW_STEPS, type WorkflowScope, type WorkflowScopeKind, type WorkflowStep, type WorkflowStepId } from "../../shared/workflow";
import { S } from "./strings";

/** 工作流程编辑器的纯逻辑（BTL-273）：加、移、删步骤，改选项，选作用域。 */

const rank = (id: WorkflowStepId) => WORKFLOW_STEPS.indexOf(id);

/** 还能加的步骤（按词表的顺序）。 */
export function addableSteps(steps: WorkflowStep[]): WorkflowStepId[] {
  return WORKFLOW_STEPS.filter((id) => !steps.some((s) => s.id === id));
}

/** 加一步：放在词表顺序里比它靠前的最后一步后面（这样加出来的顺序总是合规的）。已经有了就不变。 */
export function insertStep(steps: WorkflowStep[], id: WorkflowStepId): WorkflowStep[] {
  if (steps.some((s) => s.id === id)) return steps;
  let at = 0;
  steps.forEach((s, i) => {
    if (rank(s.id) < rank(id)) at = i + 1;
  });
  return [...steps.slice(0, at), { id }, ...steps.slice(at)];
}

export function moveStep(steps: WorkflowStep[], i: number, dir: -1 | 1): WorkflowStep[] {
  const j = i + dir;
  if (i < 0 || i >= steps.length || j < 0 || j >= steps.length) return steps;
  const out = [...steps];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function removeStep(steps: WorkflowStep[], i: number): WorkflowStep[] {
  return steps.filter((_, k) => k !== i);
}

type StepOptions = Partial<Pick<WorkflowStep, "note" | "draft" | "bot" | "maxRounds" | "mergeBy">>;

/** 改一步的选项：空的 note、false 的 draft、undefined 的值都去掉（和存下来的规整形式一样）。 */
export function setStepOption(steps: WorkflowStep[], i: number, patch: StepOptions): WorkflowStep[] {
  return steps.map((s, k) => {
    if (k !== i) return s;
    const next: Record<string, unknown> = { ...s, ...patch };
    for (const [key, v] of Object.entries(next)) {
      if (v === undefined || v === false || (key === "note" && typeof v === "string" && v.trim() === "")) delete next[key];
    }
    return next as unknown as WorkflowStep;
  });
}

/** 「加一层」里选的种类和目标 → 作用域；目标没选为 null。 */
export function scopeFor(kind: WorkflowScopeKind, target: string): WorkflowScope | null {
  if (kind === "global") return { kind: "global" };
  if (!target) return null;
  if (kind === "product") return { kind: "product", productId: Number(target) };
  if (kind === "repo") return { kind: "repo", slug: target };
  if (kind === "feature") return { kind: "feature", featureId: Number(target) };
  return { kind: "ticket", ticketKey: target };
}

export function layerTitle(scope: WorkflowScope, label: string): string {
  return S.workflow.scopeLabel(S.workflow.scope[scope.kind], scope.kind === "global" ? "" : label);
}
