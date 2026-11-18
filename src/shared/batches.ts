/** 一批改动的来源：人在页面上做的 / 流水线自动做的 / 导入。 */
export type BatchOrigin = "manual" | "auto" | "import";
export const BATCH_ORIGINS: readonly BatchOrigin[] = ["manual", "auto", "import"];

/** 批次里一行的简述（由实体适配器从快照里取）：页面上显示「文字 · 之前 → 之后」。 */
export interface BatchItemView {
  entity: string;
  entityId: number;
  label: string;
  before: string | null;
  after: string | null;
}

export interface BatchView {
  id: number;
  createdAt: number;
  /** confirm / reject / disable / enable / delete / edit / merge / accept_recommended / import / policy / undo / … */
  kind: string;
  origin: BatchOrigin;
  entity: string;
  scope: Record<string, unknown>;
  summary: Record<string, unknown>;
  affected: number;
  undoneAt: number | null;
  undoOf: number | null;
  /** 还能撤销：不是撤销批次、也还没被撤销过。 */
  undoable: boolean;
}

export interface BatchDetail extends BatchView {
  items: BatchItemView[];
}

/** 批量动作的结果：affected = 真正变了的行，skipped = 命中但本来就是目标状态（或撤销时已经被别的改动改过）的行。 */
export interface BatchOutcome {
  batchId: number | null;
  affected: number;
  skipped: number;
}
