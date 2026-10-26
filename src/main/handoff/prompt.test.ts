import { describe, expect, it } from "vitest";
import type { Followup, Ticket } from "../../shared/types";
import { buildPrompt, renderTemplate, repoBranches, retryPrompt } from "./prompt";
import { emptyHandoff } from "./schema";
import { HANDOFF_EXAMPLE } from "./templates";

const t: Ticket = {
  key: "PROJ-1", title: null,
  repos: [{ id: 1, ticketKey: "PROJ-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "feature/PROJ-1", createdAt: 1, worktreeRemovedAt: null, cleanupBlocked: null }],
  status: "active", statusManual: null, createdAt: 1, archivedAt: null, featureId: null,
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

describe("{{branch}} for several repos", () => {
  const repo = (id: number, path: string, branch: string) => ({ id, ticketKey: "PROJ-1", repoPath: path, workMode: "branch" as const, worktreePath: null, branch, createdAt: 1, worktreeRemovedAt: null, cleanupBlocked: null });
  it("is the branch for one repo, repo@branch for several, and says so when there is none", () => {
    expect(repoBranches({ ...t, repos: [repo(1, "/c/web", "feature/PROJ-1")] })).toBe("feature/PROJ-1");
    const two = repoBranches({ ...t, repos: [repo(1, "/c/web", "feature/PROJ-1"), repo(2, "/c/api", "api/PROJ-1")] });
    expect(two).toMatch(/^web@feature\/PROJ-1, api@api\/PROJ-1（多个仓库：每个仓库的 PR 都放进 prs）$/);
    expect(repoBranches({ ...t, repos: [] })).toBe("（还没有关联仓库）");
  });
});
