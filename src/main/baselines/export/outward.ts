// 对外动作（契约 4.8）在 E2 这边用到的那部分：B 的 ExternalActions 的 allowed / attempt。
// 导出成 lint 只用两种：branch_push（推送 Shipherd 建的分支）和 pr_open。
import type { ExternalActions } from "../../external/actions";

export type OutwardKind = "branch_push" | "pr_open";
export type OutwardGate = Pick<ExternalActions, "allowed" | "attempt">;
