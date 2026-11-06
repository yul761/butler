import { describe, expect, it } from "vitest";
import type { EpicHistoryEntry } from "../db/epic-history-repo";
import { EPIC_HISTORY_BRIEF_CHARS, renderHistory } from "./epic-history-view";

describe("renderHistory", () => {
  const entry = (n: number, over: Partial<EpicHistoryEntry> = {}): EpicHistoryEntry => ({
    id: n, epicId: 1, featureId: null, trigger: "weekly", createdAt: new Date(2026, 10, n).getTime(), coversFrom: 0, coversUntil: 0,
    payload: { summary: `第${n}次整理`, decisions: [{ what: `决定${n}`, why: `原因${n}` }] }, ...over,
  });

  it("renders newest first with the decisions and their reasons, in both languages", () => {
    const zh = renderHistory([entry(2), entry(1, { trigger: "feature_archived" })], "zh", EPIC_HISTORY_BRIEF_CHARS);
    expect(zh.indexOf("第2次整理")).toBeLessThan(zh.indexOf("第1次整理"));
    expect(zh).toContain("2026-11-02");
    expect(zh).toContain("决定2");
    expect(zh).toContain("原因2");
    expect(zh).toContain("feature 归档");
    const en = renderHistory([entry(1)], "en", EPIC_HISTORY_BRIEF_CHARS);
    expect(en).toContain("Decisions");
    expect(en).toContain("weekly");
    expect(renderHistory([], "zh", EPIC_HISTORY_BRIEF_CHARS)).toBe("");
  });

  it("renderHistory drops the oldest entries to fit", () => {
    const entries = [3, 2, 1].map((n) => entry(n, { payload: { summary: `第${n}次${"字".repeat(400)}`, decisions: [] } }));
    const text = renderHistory(entries, "zh", 1000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain("第3次");
    expect(text).toContain("第2次");
    expect(text).not.toContain("第1次");
    // 最新的一条本身就放不下时，截掉它的结尾。
    const one = renderHistory([entry(9, { payload: { summary: "长".repeat(5000), decisions: [] } })], "zh", 1000);
    expect(one.length).toBe(1000);
    expect(one).toContain("2026-11-09");
    expect(renderHistory([entry(1)], "zh", 0)).toBe("");
  });
});
