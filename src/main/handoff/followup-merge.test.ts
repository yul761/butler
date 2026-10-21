import { describe, expect, it } from "vitest";
import type { HandoffFollowup } from "../../shared/handoff";
import type { Followup } from "../../shared/types";
import { normalizeDescription, planFollowupMerge } from "./followup-merge";

const existing = (id: string, over: Partial<Followup> = {}): Followup => ({
  id, ticketKey: "PROJ-1", kind: "config", description: `改配置 ${id}`, trigger: "after_merge", dueDate: null,
  status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null, ...over,
});
const incoming = (over: Partial<HandoffFollowup> = {}): HandoffFollowup => ({
  id: null, kind: "config", description: "新的事", trigger: "after_merge", due_date: null, done: false, ...over,
});
const ctx = () => {
  let n = 0;
  return { ticketKey: "PROJ-1", now: 100, newId: () => `new${++n}`, source: "session" as const };
};

describe("planFollowupMerge", () => {
  it("creates new items with app-assigned ids and keeps due_date only for on_date", () => {
    const plan = planFollowupMerge(
      [],
      [
        incoming(),
        incoming({ description: "开开关", trigger: "on_date", due_date: "2026-10-30" }),
        incoming({ description: "部署", trigger: "after_deploy", due_date: "2026-10-30" }),
      ],
      ctx(),
    );
    expect(plan.inserts.map((f) => [f.id, f.description, f.dueDate, f.status, f.createdAt, f.source])).toEqual([
      ["new1", "新的事", null, "open", 100, "session"],
      ["new2", "开开关", "2026-10-30", "open", 100, "session"],
      ["new3", "部署", null, "open", 100, "session"],
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.done).toEqual([]);
  });

  it("updates an existing item by id and marks done ones", () => {
    const plan = planFollowupMerge(
      [existing("a"), existing("b")],
      [incoming({ id: "a", description: "改配置 a（staging 和 prod）", trigger: "after_deploy" }), incoming({ id: "b", description: "改配置 b", done: true })],
      ctx(),
    );
    expect(plan.updates).toEqual([{ id: "a", patch: { trigger: "after_deploy", description: "改配置 a（staging 和 prod）" } }]);
    expect(plan.done).toEqual(["b"]);
    expect(plan.inserts).toEqual([]);
  });

  it("matches a forgotten id by description, so nothing is duplicated", () => {
    const plan = planFollowupMerge([existing("a")], [incoming({ description: "  改配置   A " })], ctx());
    expect(plan).toEqual({ inserts: [], updates: [], done: [] });
  });

  it("never revives ignored items or reopens done ones", () => {
    const plan = planFollowupMerge(
      [existing("a", { status: "ignored" }), existing("b", { status: "done" })],
      [incoming({ id: "a" }), incoming({ description: "改配置 b" }), incoming({ id: "b", trigger: "none" })],
      ctx(),
    );
    expect(plan).toEqual({ inserts: [], updates: [], done: [] });
  });

  it("treats an unknown id as a new item and drops duplicates, done-on-arrival and blank items", () => {
    const plan = planFollowupMerge(
      [],
      [incoming({ id: "f_made_up" }), incoming({ description: "新的事 " }), incoming({ description: "已做完", done: true }), incoming({ description: "  " })],
      ctx(),
    );
    expect(plan.inserts.map((f) => f.description)).toEqual(["新的事"]);
  });

  it("treats full-width and half-width punctuation as the same description", () => {
    expect(normalizeDescription("改（配置）")).toBe(normalizeDescription("改(配置)"));
    const plan = planFollowupMerge([existing("a", { description: "改(配置)" })], [incoming({ description: "改（配置）", done: true })], ctx());
    expect(plan.done).toEqual(["a"]);
    expect(plan.inserts).toEqual([]);
  });

  it("done wins over a non-done entry for the same target, in either order", () => {
    for (const order of [[false, true], [true, false]]) {
      const plan = planFollowupMerge(
        [existing("a")],
        order.map((done) => incoming({ id: "a", description: "改配置 a", kind: done ? "config" : "deploy", done })),
        ctx(),
      );
      expect(plan.done).toEqual(["a"]);
      expect(plan.updates).toEqual([]);
    }
    for (const order of [[false, true], [true, false]]) {
      const plan = planFollowupMerge([], order.map((done) => incoming({ description: "新的事", done })), ctx());
      expect(plan.inserts).toEqual([]);
    }
  });

  it("snoozed items can be completed or edited and keep their snooze otherwise", () => {
    const plan = planFollowupMerge(
      [existing("a", { status: "snoozed", snoozedUntil: "2026-10-22" }), existing("b", { status: "snoozed" })],
      [incoming({ id: "a", description: "改配置 a", done: true }), incoming({ id: "b", description: "改配置 b", kind: "deploy" })],
      ctx(),
    );
    expect(plan.done).toEqual(["a"]);
    expect(plan.updates).toEqual([{ id: "b", patch: { kind: "deploy" } }]);
  });
});
