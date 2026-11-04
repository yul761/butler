import type { MergeEvent } from "../../shared/types";
import type { UiStrings } from "./strings";

/** 一句话拆成片段：字符串是普通文字，{ ticket } 是要渲染成可点按钮的 ticket 号。 */
export type MergeEventPart = string | { ticket: string };

// 文案模板用占位符调用，再按占位符拆开，这样中英文语序不同也能定位 ticket。
const WHO = "@@who@@";
const OTHER = "@@other@@";

/** repoPath 的最后一段（兼容 Windows 路径和末尾分隔符）。 */
function lastSegment(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** text 是纯文字；parts 把有 ticket 号的名字单独拆出来。没有 ticket 号时用 branch 名，只显示文字。 */
export function mergeEventText(e: MergeEvent, S: UiStrings): { repo: string; text: string; parts: MergeEventPart[] } {
  const who = e.ticketKey ?? e.branch;
  const other = e.otherTicket ?? e.otherBranch ?? "";
  const template = S.mergeEvent[e.kind](WHO, OTHER);
  const parts: MergeEventPart[] = [];
  for (const seg of template.split(/(@@who@@|@@other@@)/)) {
    if (seg === WHO) parts.push(e.ticketKey ? { ticket: e.ticketKey } : who);
    else if (seg === OTHER) parts.push(e.otherTicket ? { ticket: e.otherTicket } : other);
    else if (seg) parts.push(seg);
  }
  const text = parts.map((p) => (typeof p === "string" ? p : p.ticket)).join("");
  return { repo: lastSegment(e.repoPath), text, parts };
}
