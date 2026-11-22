// 「发送反馈」对话框的开关（BTL-254）：设置「关于」、向导失败的步骤、菜单都从这里打开同一个对话框。
import type { FeedbackKind } from "../../shared/feedback";

export interface FeedbackRequest {
  kind?: FeedbackKind;
  /** 首次使用向导里出问题的那一步。 */
  step?: string;
}

type Listener = (r: FeedbackRequest) => void;
const listeners = new Set<Listener>();

export function openFeedback(r: FeedbackRequest = {}): void {
  for (const l of listeners) l(r);
}

export function onOpenFeedback(l: Listener): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
