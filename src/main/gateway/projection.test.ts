import { describe, expect, it } from "vitest";
import { LIST_LIMIT, project, TEXT_LIMIT, truncateOutside } from "./projection";
import { Pseudonymizer } from "./pseudonym";
import { seededRng } from "./testing";
import type { NarrativeSource } from "./types";

const source = (): NarrativeSource => ({
  date: "2026-10-21",
  tickets: [
    {
      key: "PROJ-12", status: "active", pr: null, daysInStatus: 1, idleDays: 0, doneLastDay: 2,
      nextSteps: ["修好 PROJ-12 的登录", "第二步", "第三步", "第四步"], blockers: ["等张三回复"],
      followups: [{ kind: "config", trigger: "after_merge", description: "改 acme-billing 的 staging 配置", overdueDays: null }],
    },
    {
      key: "PROJ-123", status: "in_review", pr: { state: "open", review: "approved" }, daysInStatus: 3, idleDays: 1, doneLastDay: 0,
      nextSteps: [], blockers: [], followups: [],
    },
  ],
  items: [
    { section: "today", rule: "next_step", ticketKey: "PROJ-12", days: null, count: null },
    { section: "first", rule: "pr_approved", ticketKey: "PROJ-123", days: null, count: null },
    { section: "watch", rule: "unclaimed", ticketKey: null, days: null, count: 2 },
  ],
  known: { tickets: ["PROJ-12", "PROJ-123"], repos: ["acme-billing"], branches: ["feature/PROJ-12-login"] },
});
const pseudonymizer = (src: NarrativeSource, seed: number) => new Pseudonymizer({ ...src.known, people: ["张三"], terms: [] }, seededRng(seed));

describe("project", () => {
  it("metadata sends only placeholder ids, enums, counts and days", () => {
    const src = source();
    const p = pseudonymizer(src, 4);
    const out = project(src, "metadata", p, seededRng(5));
    const json = JSON.stringify(out);
    for (const v of ["PROJ-12", "PROJ-123", "acme-billing", "张三", "登录", "staging"]) expect(json).not.toContain(v);
    expect(out.tickets.every((t) => !("next_steps" in t) && !("blockers" in t) && t.followups.every((f) => !("description" in f)))).toBe(true);
    expect(out.tickets.map((t) => t.id).sort()).toEqual([p.token("T", "PROJ-12"), p.token("T", "PROJ-123")].sort());
    expect(out.tickets.find((t) => t.id === p.token("T", "PROJ-123"))).toMatchObject({
      status: "in_review", pr: { state: "open", review: "approved" }, days_in_status: 3, idle_days: 1, done_last_day: 0,
    });
    expect(out.items.map((i) => i.section)).toEqual(["first", "today", "watch"]);
    expect(out.items[2]).toEqual({ section: "watch", rule: "unclaimed", ticket: null, days: null, count: 2 });
  });

  it("redacted adds pseudonymized, capped next steps, blockers and followup descriptions", () => {
    const src = source();
    const p = pseudonymizer(src, 6);
    const out = project(src, "redacted", p, seededRng(7));
    const t = out.tickets.find((x) => x.id === p.token("T", "PROJ-12"))!;
    expect(t.next_steps).toEqual([`修好 ${p.token("T", "PROJ-12")} 的登录`, "第二步", "第三步"]);
    expect(t.next_steps).toHaveLength(LIST_LIMIT);
    expect(t.blockers).toEqual([`等${p.token("P", "张三")}回复`]);
    expect(t.followups[0].description).toBe(`改 ${p.token("R", "acme-billing")} 的 staging 配置`);
    const long = project({ ...src, tickets: [{ ...src.tickets[0], nextSteps: ["长".repeat(500)] }] }, "redacted", p, seededRng(7));
    expect([...long.tickets[0].next_steps![0]]).toHaveLength(TEXT_LIMIT + 1);
  });

  it("full sends real keys and text with no placeholders", () => {
    const src = source();
    const out = project(src, "full", pseudonymizer(src, 8), seededRng(9));
    expect(out.tickets.map((t) => t.id).sort()).toEqual(["PROJ-12", "PROJ-123"]);
    expect(JSON.stringify(out)).not.toContain("[[");
    expect(out.tickets.find((t) => t.id === "PROJ-12")?.blockers).toEqual(["等张三回复"]);
  });

  it("shuffles tickets per request so the position does not identify a ticket", () => {
    const base = source();
    const src = { ...base, tickets: Array.from({ length: 8 }, (_, i) => ({ ...base.tickets[1], key: `K-${i}` })) };
    const orders = new Set<string>();
    for (let seed = 1; seed <= 6; seed++) orders.add(project(src, "full", pseudonymizer(src, seed), seededRng(seed)).tickets.map((t) => t.id).join(","));
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("truncateOutside", () => {
  it("truncates without cutting a placeholder in half", () => {
    expect(truncateOutside("abcdef", 10)).toBe("abcdef");
    expect(truncateOutside("ab [[T_abcd]] cd", 6)).toBe("ab…");
    expect(truncateOutside("一二三四五六七八", 4)).toBe("一二三四…");
  });
});
