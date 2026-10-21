import type { Handoff } from "../../shared/handoff";
import type { Followup, Ticket, TicketStatus } from "../../shared/types";
import { HANDOFF_EXAMPLE, HANDOFF_SCHEMA_DOC } from "./templates";

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

function vars(c: PromptContext): Record<string, string> {
  return {
    ticket: c.ticket.key,
    title: c.ticket.title ?? "无标题",
    branch: c.ticket.branch,
    current_status: c.status,
    tracker_tools: c.trackerTools.length > 0 ? c.trackerTools.join(", ") : "（没有配置 tracker MCP 工具：jira 填 null）",
    previous_handoff: c.previous ? JSON.stringify(c.previous, null, 2) : "（这是第一次 handoff）",
    open_followups: JSON.stringify(
      c.openFollowups.map((f) => ({ id: f.id, kind: f.kind, description: f.description, trigger: f.trigger, due_date: f.dueDate })),
      null,
      2,
    ),
    schema: HANDOFF_SCHEMA_DOC,
    example: HANDOFF_EXAMPLE,
  };
}

export function buildPrompt(template: string, c: PromptContext): string {
  return renderTemplate(template, vars(c));
}

export function retryPrompt(prompt: string, errors: string): string {
  return `${prompt}\n\n上一次的输出没有通过校验，错误如下：\n${errors}\n请修正这些问题，按 schema 重新输出完整的 JSON。`;
}
