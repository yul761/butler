import { describe, expect, it, vi } from "vitest";
import type { MemoryItem, WhyEntry } from "../../shared/memory";
import { memoryChangeConcerns, memorySections, trailingDebounce, whyLines } from "./memory-view";
import { S } from "./strings";

const item = (text: string, group = "Notes", factId: string | null = "id"): MemoryItem => ({ factKey: text, factId, text, createdAt: null, group });
const entry = (over: Partial<WhyEntry>): WhyEntry => ({ id: "x", content: "", addedAt: "2026-10-21T01:00:00.000Z", supersededBy: null, retiredAt: null, retiredReason: null, ...over });

describe("memory view helpers", () => {
  it("splits Butler's decisions and followups from other notes and strips the prefix", () => {
    const sections = memorySections([
      item("[decision:db] 用 MySQL"),
      item("[followup:f_1#2 abcd efgh ijkl] 改配置"),
      item("Claude 记的：用 pnpm"),
      item("偏好 tabs", "Preferences"),
      item("[decision:cache] 不用缓存"),
    ]);
    expect(sections.map((s) => s.title)).toEqual([S.memoryDecisions, S.memoryFollowups, S.memoryNotes, "Preferences"]);
    expect(sections[0].rows.map((r) => r.text)).toEqual(["用 MySQL", "不用缓存"]);
    expect(sections[1].rows.map((r) => r.text)).toEqual(["改配置"]);
    expect(sections[2].rows.map((r) => r.text)).toEqual(["Claude 记的：用 pnpm"]);
    expect(memorySections([])).toEqual([]);
  });

  it("labels every version of a why chain", () => {
    const lines = whyLines(
      [
        entry({ content: "[decision:db] 用 PostgreSQL", supersededBy: "b" }),
        entry({ content: "[decision:db] 用 MySQL" }),
        entry({ content: "被淘汰的笔记", retiredAt: "2026-10-22T00:00:00.000Z", retiredReason: "cap_evicted" }),
      ],
      (iso) => iso.slice(0, 10),
    );
    expect(lines).toEqual([
      { text: "用 PostgreSQL", when: "2026-10-21", state: "replaced", note: null },
      { text: "用 MySQL", when: "2026-10-21", state: "current", note: null },
      { text: "被淘汰的笔记", when: "2026-10-21", state: "retired", note: S.whyRetiredReason("cap_evicted") },
    ]);
  });
});

describe("memoryChangeConcerns (final review 4: the memory tab reloads only on memory events for its ticket)", () => {
  it("reloads for its own ticket and for a memory switch change, not for other tickets", () => {
    expect(memoryChangeConcerns("PROJ-1", "PROJ-1")).toBe(true);
    expect(memoryChangeConcerns(null, "PROJ-1")).toBe(true);
    expect(memoryChangeConcerns("PROJ-2", "PROJ-1")).toBe(false);
  });
});

describe("trailingDebounce", () => {
  it("collapses a burst into one trailing call and can be cancelled", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = trailingDebounce(fn, 500);
      d();
      vi.advanceTimersByTime(300);
      d();
      vi.advanceTimersByTime(300);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(fn).toHaveBeenCalledTimes(1);
      d();
      d.cancel();
      vi.advanceTimersByTime(1000);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
