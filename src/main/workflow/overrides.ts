import type { LoopPolicy } from "../../shared/loop-policy";
import { hasStep, workflowWantsComments, type Workflow } from "../../shared/workflow";

/**
 * 工作流程优先于自动化档位和原来的开关（BTL-273，契约：档位只是总开关）。
 * 预审：这个 ticket 有流程时，流程里有 pre_review 才跑；没有流程按原来的（档位、设置）。
 */
export function preReviewWithWorkflow(w: Workflow | null, base: boolean): boolean {
  return w === null ? base : hasStep(w, "pre_review");
}

/** 评论闭环：流程里有 review 类的步骤时，评论一定要转给 session（不然处理评论这一步永远做不完）；流程不会把开着的关掉。 */
export function loopWithWorkflow(w: Workflow | null, policy: LoopPolicy): LoopPolicy {
  return workflowWantsComments(w) && !policy["comments.enabled"] ? { ...policy, "comments.enabled": true } : policy;
}
