import type { Lang } from "../../shared/i18n";
import { truncateUnits } from "../../shared/memory";
import type { EpicHistoryEntry, EpicHistoryTrigger } from "../db/epic-history-repo";
import { localDate } from "../schedule/calendar";

/** 拼进新 feature 总控第一条消息的"以往的决定"最多这么多字（超出时去掉最旧的）；epic_context 的 history 也用它。 */
export const EPIC_HISTORY_BRIEF_CHARS = 3000;
/** 渲染"以往的决定"时最多读这么多条记录（之后按字数截掉最旧的）：第一条消息和 epic_context 都用它。 */
export const EPIC_HISTORY_READ_ENTRIES = 20;

const TEXT = {
  zh: {
    trigger: { weekly: "每周整理", feature_archived: "feature 归档时整理" } satisfies Record<EpicHistoryTrigger, string>,
    heading: (date: string, trigger: string) => `### ${date}（${trigger}）`,
    decisions: "决定：",
    decision: (what: string, why: string) => (why ? `- ${what}（原因：${why}）` : `- ${what}`),
  },
  en: {
    trigger: { weekly: "weekly digest", feature_archived: "digest when a feature was archived" } satisfies Record<EpicHistoryTrigger, string>,
    heading: (date: string, trigger: string) => `### ${date} (${trigger})`,
    decisions: "Decisions:",
    decision: (what: string, why: string) => (why ? `- ${what} (why: ${why})` : `- ${what}`),
  },
};

function renderEntry(e: EpicHistoryEntry, lang: Lang): string {
  const t = TEXT[lang];
  const lines = [t.heading(localDate(e.createdAt), t.trigger[e.trigger])];
  if (e.payload.summary.trim()) lines.push(e.payload.summary.trim());
  if (e.payload.decisions.length > 0) lines.push(t.decisions, ...e.payload.decisions.map((d) => t.decision(d.what.trim(), d.why.trim())));
  return lines.join("\n");
}

/**
 * 渲染"以往的决定"（epic_history 的全文，计划 16 任务 6）：最新的在前，超过 maxChars 时去掉最旧的。
 * 最新的一条本身就放不下时截掉它的结尾。没有记录（或 maxChars 不是正数）时是空串。只渲染，不碰 LLM。
 */
export function renderHistory(entries: EpicHistoryEntry[], lang: Lang, maxChars: number): string {
  if (maxChars <= 0) return "";
  const sorted = [...entries].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  let out = "";
  for (const e of sorted) {
    const block = renderEntry(e, lang);
    const next = out ? `${out}\n\n${block}` : block;
    if (next.length > maxChars) {
      if (!out) out = truncateUnits(block, maxChars).trim();
      break;
    }
    out = next;
  }
  return out;
}
