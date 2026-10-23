import { describe, expect, it } from "vitest";
import type { Handoff } from "../../shared/handoff";
import type { MemoryItem } from "../../shared/memory";
import type { Followup, HandoffRecord, HandoffTrigger } from "../../shared/types";
import { NOTE_BODY_LIMIT } from "../../shared/memory";
import { BUTLER_NOTE_LIMIT, decisionNote, desiredNotes, followupNote, planReconcile } from "./notes";

const payload = (over: Partial<Handoff> = {}): Handoff => ({
  ticket: "PROJ-1", status: "active", done_today: [], next_steps: [], blockers: [], prs: [], jira: null,
  followups: [], decisions: [], learnings: [], open_questions: [], ...over,
});
let nextId = 1;
const handoff = (createdAt: number, p: Handoff | null, trigger: HandoffTrigger = "nightly"): HandoffRecord => ({
  id: nextId++, ticketKey: "PROJ-1", sessionId: null, trigger, createdAt, payload: p, degraded: p === null, rawText: null, sourceRef: null,
});
const followup = (id: string, over: Partial<Followup> = {}): Followup => ({
  id, ticketKey: "PROJ-1", kind: "config", description: `描述 ${id}`, trigger: "after_merge", dueDate: null,
  status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null, ...over,
});
const item = (text: string, factKey = `k:${text}`): MemoryItem => ({ factKey, factId: null, text, createdAt: null, group: "Notes" });

describe("followup and decision notes", () => {
  it("describes a followup with its kind, trigger and due date", () => {
    expect(followupNote(followup("f_1", { description: "改 staging 配置" }))).toEqual({ kind: "followup", id: "f_1", body: "改 staging 配置（配置，合并后）" });
    expect(followupNote(followup("f_2", { kind: "flag", trigger: "on_date", dueDate: "2026-11-01", description: "关掉开关" })).body).toBe("关掉开关（开关，到期日 2026-11-01）");
    // 不用全角的说明后缀也不被 NFKC 改写，多个逗号不受影响。
    expect(followupNote(followup("f_3", { description: "x" })).body).toBe("x（配置，合并后）");
    expect(decisionNote("db]#1", "用\nMySQL")).toEqual({ kind: "decision", id: "db-1", body: "用 MySQL" });
  });
});

describe("followupNote limits", () => {
  it("truncates a long description so the whole body fits, keeping the suffix", () => {
    const n = followupNote(followup("f_1", { description: "长".repeat(900), trigger: "on_date", dueDate: "2026-11-01" }));
    expect(n.body.length).toBe(NOTE_BODY_LIMIT);
    expect(n.body.endsWith("（配置，到期日 2026-11-01）")).toBe(true);
    const emoji = followupNote(followup("f_2", { description: "😀".repeat(900) }));
    expect(emoji.body.length).toBeLessThanOrEqual(NOTE_BODY_LIMIT);
    expect(emoji.body.endsWith("（配置，合并后）")).toBe(true);
  });

  it("caps a pathological due date so the description survives", () => {
    const n = followupNote(followup("f_1", { description: "改配置", trigger: "on_date", dueDate: "9".repeat(800) }));
    expect(n.body.startsWith("改配置（配置，到期日 ")).toBe(true);
    expect(n.body.length).toBeLessThanOrEqual(NOTE_BODY_LIMIT);
  });
});

describe("desiredNotes", () => {
  it("keeps the latest statement per decision key from full handoffs only", () => {
    const hs = [
      handoff(10, payload({ decisions: [{ key: "db", statement: "用 PostgreSQL" }, { key: "cache", statement: "不用缓存" }] })),
      handoff(20, payload({ decisions: [{ key: "db", statement: "用 MySQL" }] })),
      handoff(30, payload({ decisions: [{ key: "db", statement: "刷新里编的" }] }), "refresh"),
      handoff(40, null),
    ];
    expect(desiredNotes(hs, [])).toEqual([
      { kind: "decision", id: "db", body: "用 MySQL" },
      { kind: "decision", id: "cache", body: "不用缓存" },
    ]);
  });

  it("orders handoffs by time no matter how they are passed in", () => {
    const a = handoff(10, payload({ decisions: [{ key: "db", statement: "旧" }] }));
    const b = handoff(20, payload({ decisions: [{ key: "db", statement: "新" }] }));
    expect(desiredNotes([b, a], [])).toEqual([{ kind: "decision", id: "db", body: "新" }]);
  });

  it("lists open and snoozed followups first, skips closed ones and empty bodies", () => {
    const fs = [
      followup("f_1"),
      followup("f_2", { status: "done" }),
      followup("f_3", { status: "ignored" }),
      followup("f_4", { status: "snoozed", createdAt: 2 }),
    ];
    const hs = [handoff(10, payload({ decisions: [{ key: "x", statement: "  " }, { key: "y", statement: "有内容" }] }))];
    expect(desiredNotes(hs, fs).map((n) => `${n.kind}:${n.id}`)).toEqual(["followup:f_1", "followup:f_4", "decision:y"]);
  });

  it("puts recently changed decisions first and caps the total", () => {
    const hs = [
      handoff(10, payload({ decisions: [{ key: "old", statement: "早就定了" }, { key: "changed", statement: "第一版" }] })),
      handoff(20, payload({ decisions: [{ key: "old", statement: "早就定了" }, { key: "changed", statement: "第二版" }] })),
    ];
    expect(desiredNotes(hs, []).map((n) => n.id)).toEqual(["changed", "old"]);
    const many = Array.from({ length: 40 }, (_, i) => followup(`f_${i}`, { createdAt: i }));
    expect(desiredNotes([], many)).toHaveLength(BUTLER_NOTE_LIMIT);
  });
});

describe("planReconcile", () => {
  it("keeps unchanged notes, replaces changed ones and forgets the ones no longer wanted", () => {
    const current = [
      item("[decision:db] 用 PostgreSQL", "k1"),
      item("[followup:f_1] 改配置（配置，合并后）", "k2"),
      item("[followup:f_2] 已经做完的", "k3"),
      item("用户喜欢 tabs", "k4"),
      item("[learning:PROJ-1] 经验", "k5"),
    ];
    const desired = [
      { kind: "decision" as const, id: "db", body: "用 MySQL" },
      { kind: "followup" as const, id: "f_1", body: "改配置（配置，合并后）" },
      { kind: "followup" as const, id: "f_9", body: "新的" },
    ];
    expect(planReconcile(current, desired)).toEqual({
      forget: ["k1", "k3"],
      write: [desired[0], desired[2]],
    });
  });

  it("treats a variant with the same body as already written, and drops duplicates of one key", () => {
    const current = [item("[followup:f_1#2] 改配置", "a"), item("[followup:f_1] 改配置", "b"), item("[followup:f_1#3] 旧的", "c")];
    expect(planReconcile(current, [{ kind: "followup", id: "f_1", body: "改  配置".replace("  ", "") }])).toEqual({ forget: ["b", "c"], write: [] });
  });

  it("ignores repeated desired keys and compares bodies loosely", () => {
    const desired = [
      { kind: "decision" as const, id: "db", body: "Use PostgreSQL" },
      { kind: "decision" as const, id: "db", body: "something else" },
    ];
    expect(planReconcile([item("[decision:db] use  postgresql", "k")], desired)).toEqual({ forget: [], write: [] });
  });
});
