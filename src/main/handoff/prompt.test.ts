import { describe, expect, it } from "vitest";
import type { Followup, Ticket } from "../../shared/types";
import { buildPrompt, renderTemplate, retryPrompt } from "./prompt";
import { emptyHandoff } from "./schema";
import { HANDOFF_EXAMPLE } from "./templates";

const t: Ticket = {
  key: "PROJ-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "feature/PROJ-1",
  status: "active", statusManual: null, createdAt: 1, archivedAt: null,
};
const f: Followup = {
  id: "f1", ticketKey: "PROJ-1", kind: "flag", description: "开 flag {{ticket}}", trigger: "on_date", dueDate: "2026-10-30",
  status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null,
};

describe("prompt rendering", () => {
  it("fills known placeholders, keeps unknown ones and never re-expands inserted values", () => {
    expect(renderTemplate("{{a}}/{{missing}}", { a: "{{a}}x" })).toBe("{{a}}x/{{missing}}");
  });

  it("builds the handoff prompt from the ticket, previous handoff, followups and tracker tools", () => {
    const p = buildPrompt("{{ticket}}|{{title}}|{{branch}}|{{current_status}}|{{tracker_tools}}|{{previous_handoff}}|{{open_followups}}|{{example}}", {
      ticket: t, status: "in_review", previous: { ...emptyHandoff("PROJ-1"), next_steps: ["下一步"] }, openFollowups: [f], trackerTools: ["mcp__jira__get_issue"],
    });
    expect(p.startsWith("PROJ-1|无标题|feature/PROJ-1|in_review|mcp__jira__get_issue|")).toBe(true);
    expect(p).toContain('"next_steps": [\n    "下一步"\n  ]');
    expect(p).toContain('"id": "f1"');
    expect(p).toContain('"due_date": "2026-10-30"');
    expect(p).toContain("开 flag {{ticket}}");
    expect(p).toContain(HANDOFF_EXAMPLE);
  });

  it("explains a first handoff and missing tracker tools", () => {
    const p = buildPrompt("{{previous_handoff}} / {{tracker_tools}} / {{open_followups}}", { ticket: t, status: "active", previous: null, openFollowups: [], trackerTools: [] });
    expect(p).toBe("（这是第一次 handoff） / （没有配置 tracker MCP 工具：jira 填 null） / []");
  });

  it("appends validation errors for the retry", () => {
    expect(retryPrompt("原始", "✖ bad\n  → at status")).toBe(
      "原始\n\n上一次的输出没有通过校验，错误如下：\n✖ bad\n  → at status\n请修正这些问题，按 schema 重新输出完整的 JSON。",
    );
  });
});
