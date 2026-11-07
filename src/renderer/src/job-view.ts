import type { JobStateView } from "../../shared/types";
import { S } from "./strings";

/** 手动运行晚间 handoff 结束后给用户看的一句话。 */
export function jobResultMessage(j: JobStateView): string {
  if (j.lastStatus === "partial") return S.jobPartial;
  if (j.lastStatus === "failed") return S.jobFailed(j.lastError ?? "");
  return S.jobOk;
}
