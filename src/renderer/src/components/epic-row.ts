import type { EpicFeatureRow, EpicView, FeatureView } from "../../../shared/types";
import { ButlerError } from "../api";
import { firstSentence } from "../feature-summary-view";
import type { UiStrings } from "../strings";

export { firstSentence };

/** epic 页的一行：一句进度（汇总的第一句）、状态文字，以及要不要标成卡住。 */
export function epicRowText(row: EpicFeatureRow, S: UiStrings): { progress: string; status: string; stuck: boolean } {
  return {
    progress: firstSentence(row.summary ?? "") || S.epicNoSummary,
    status: S.epicStatus[row.status],
    stuck: row.status === "stuck",
  };
}

/** epic session 打不开时的提示：openEpic 借用了 no_ticket、no_repo 这两个原因，不能显示 ticket 的说法。 */
export function epicOpenError(reason: string, S: UiStrings): string {
  return S.epicOpenErrors[reason] ?? S.openErrors[reason] ?? reason;
}

/** epic 的操作失败时的提示：先用 epic 自己的说法，再用共用的，都没有就用主进程的消息（已经按语言翻好）。 */
export function epicErrorText(e: unknown, S: UiStrings): string {
  if (!(e instanceof ButlerError)) return (e as Error).message;
  return S.epicErrors[e.code] ?? S.createErrors[e.code] ?? e.message;
}

/** 列在 Feature 分组里的 feature：属于侧栏上某个 epic 的只列在那个 epic 下面；epic 不在列表里的留在这里，不会从侧栏消失。 */
export function featuresOutsideEpics(features: FeatureView[], epics: EpicView[]): FeatureView[] {
  const listed = new Set(epics.map((e) => e.id));
  return features.filter((f) => f.epicId === null || !listed.has(f.epicId));
}
