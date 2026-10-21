import { describe, expect, it } from "vitest";
import type { BriefItem, BriefRule } from "../../shared/brief";
import type { SessionView, TicketView } from "../../shared/types";
import { groupItems, itemActions, itemPrefill, itemTitle, openRequest } from "./brief-view";

const item = (rule: BriefRule, over: Partial<BriefItem> = {}): BriefItem => ({
  key: `${rule}:A-1`, section: "first", rule, ticketKey: "A-1", followupId: null, text: "改 staging 配置",
  days: 3, count: 2, pr: { number: 7, url: "u" }, dueDate: null, ...over,
});
const RULES: BriefRule[] = [
  "pr_approved", "pr_changes_requested", "followup_after_merge", "followup_due", "next_step", "blocked_long", "review_waiting", "stale", "unclaimed",
];
const session = (id: string): SessionView => ({
  id, ticketKey: "A-1", cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: 1,
  waitingForInput: false, replacedBy: null, dismissed: false, createdAt: 1, termId: null,
});
const ticket = (sessions: SessionView[]): TicketView => ({
  key: "A-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active",
  statusManual: null, createdAt: 1, archivedAt: null, effectiveStatus: "active", sessions, waiting: false,
});

describe("brief view helpers", () => {
  it("groups items by section in display order and drops empty sections", () => {
    const groups = groupItems([item("stale", { section: "watch" }), item("pr_approved"), item("next_step", { section: "today" })]);
    expect(groups.map((g) => g.section)).toEqual(["first", "today", "watch"]);
    expect(groupItems([item("stale", { section: "watch" })]).map((g) => g.section)).toEqual(["watch"]);
  });

  it("has a title for every rule and a prefill naming the ticket for every openable one", () => {
    for (const rule of RULES) {
      expect(itemTitle(item(rule)).length).toBeGreaterThan(0);
      const prefill = itemPrefill(item(rule));
      if (rule === "unclaimed") expect(prefill).toBeNull();
      else expect(prefill).toContain("A-1");
    }
    expect(itemTitle(item("followup_due", { days: 0, text: "开开关" }))).toBe("今天到期：开开关");
    expect(itemTitle(item("pr_approved"))).toContain("#7");
  });

  it("offers claim for unclaimed sessions and the four actions otherwise", () => {
    expect(itemActions(item("unclaimed"))).toEqual(["claim"]);
    expect(itemActions(item("next_step"))).toEqual(["open", "done", "snooze", "ignore"]);
  });

  it("opens the most recent session with the prefill, or a new one when there is none", () => {
    expect(openRequest(item("next_step"), ticket([session("s2"), session("s1")]))).toEqual({
      ticketKey: "A-1", sessionId: "s2", prefill: "继续：改 staging 配置（来自 A-1）",
    });
    expect(openRequest(item("next_step"), ticket([]))).toEqual({ ticketKey: "A-1", prefill: "继续：改 staging 配置（来自 A-1）" });
    expect(openRequest(item("unclaimed", { ticketKey: null }), undefined)).toBeNull();
  });
});
