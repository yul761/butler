import { basename } from "node:path";
import type { Handoff } from "../../shared/handoff";
import type { Followup, Ticket, TicketStatus } from "../../shared/types";
import { currentLang } from "../i18n";
import { handoffExample, handoffSchemaDoc } from "./templates";

/** 填进 prompt 的几段固定文字（设计文档 2026-10-26：跟着语言走）。 */
const FILL = {
  zh: {
    noRepos: "（还没有关联仓库）",
    manyRepos: (list: string) => `${list}（多个仓库：每个仓库的 PR 都放进 prs）`,
    untitled: "无标题",
    noTracker: "（没有配置 tracker MCP 工具：jira 填 null）",
    firstHandoff: "（这是第一次 handoff）",
    retry: (errors: string) => `上一次的输出没有通过校验，错误如下：\n${errors}\n请修正这些问题，按 schema 重新输出完整的 JSON。`,
  },
  en: {
    noRepos: "(no repos linked yet)",
    manyRepos: (list: string) => `${list} (several repos: put every repo's PR into prs)`,
    untitled: "untitled",
    noTracker: "(no tracker MCP tools configured: set jira to null)",
    firstHandoff: "(this is the first handoff)",
    retry: (errors: string) => `The previous output did not pass validation. Errors:\n${errors}\nFix them and output the complete JSON again, following the schema.`,
  },
};
const fill = () => FILL[currentLang()];

export interface PromptContext {
  ticket: Ticket;
  status: TicketStatus;
  previous: Handoff | null;
  openFollowups: Followup[];
  trackerTools: string[];
}

/** 替换 {{name}}。只扫描模板本身，插入的值不会被再次展开；不认识的占位符原样保留。 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? vars[name] : whole));
}

/**
 * {{branch}}：单仓库 ticket 就是分支名（和以前一样）；多个仓库写成“仓库名@分支”，逗号分隔，并提醒 pr 字段只填一个。
 */
export function repoBranches(t: Ticket): string {
  if (t.repos.length === 0) return fill().noRepos;
  if (t.repos.length === 1) return t.repos[0].branch;
  const list = t.repos.map((r) => `${basename(r.repoPath)}@${r.branch}`).join(", ");
  return fill().manyRepos(list);
}

function vars(c: PromptContext): Record<string, string> {
  return {
    ticket: c.ticket.key,
    title: c.ticket.title ?? fill().untitled,
    branch: repoBranches(c.ticket),
    current_status: c.status,
    tracker_tools: c.trackerTools.length > 0 ? c.trackerTools.join(", ") : fill().noTracker,
    previous_handoff: c.previous ? JSON.stringify(c.previous, null, 2) : fill().firstHandoff,
    open_followups: JSON.stringify(
      c.openFollowups.map((f) => ({ id: f.id, kind: f.kind, description: f.description, trigger: f.trigger, due_date: f.dueDate })),
      null,
      2,
    ),
    schema: handoffSchemaDoc(currentLang()),
    example: handoffExample(currentLang()),
  };
}

export function buildPrompt(template: string, c: PromptContext): string {
  return renderTemplate(template, vars(c));
}

export function retryPrompt(prompt: string, errors: string): string {
  return `${prompt}\n\n${fill().retry(errors)}`;
}
