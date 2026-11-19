import { describe, expect, it } from "vitest";
import { LESSON_FIELD_DEFAULTS, type Lesson } from "../../shared/lessons";
import type { ImportPreview, PreviewRow } from "../../shared/config-io";
import {
  confirmsLesson, maxLessonId,
  applyBulkResolution, backupKind, batchTitle, bulkCounts, bulkFilter, diffValue, effectiveResolution, EMPTY_BULK_FILTER, lessonTags, livePicked,
  needsSecondClick, rowChoosable, verbFilter,
} from "./lessons-bulk-view";
import { STRINGS } from "./strings";

const S = STRINGS.en;
const lesson = (id: number, over: Partial<Lesson> = {}): Lesson => ({
  id, scope: { kind: "repo", slug: "o/web" }, text: `t${id}`, why: "", status: "pending", hits: 1, lastSeenAt: 1, createdAt: 0, sources: [],
  ...LESSON_FIELD_DEFAULTS, scopeGlobs: [], ...over,
});

describe("bulk filter and counts", () => {
  const lessons = [
    lesson(1),
    lesson(2, { admission: "auto", score: 0.9 }),
    lesson(3, { status: "confirmed", checkability: "checkable", score: 0.5 }),
    lesson(4, { status: "disabled" }),
    lesson(5, { scope: { kind: "repo", slug: "o/api" }, admission: "auto" }),
    lesson(6, { status: "confirmed", degraded: true, degradedFrom: "big" }),
    lesson(7, { mergedInto: 3 }),
  ];

  it("turns the page filter into a LessonFilter and ignores a bad minimum score", () => {
    expect(bulkFilter({ slug: "o/web" }, EMPTY_BULK_FILTER)).toEqual({ slug: "o/web" });
    expect(bulkFilter({}, { ...EMPTY_BULK_FILTER, status: ["pending"], text: "  x ", minScore: "0.4", degradedOnly: true })).toEqual({ status: ["pending"], text: "x", minScore: 0.4, degraded: true });
    expect(bulkFilter({}, { ...EMPTY_BULK_FILTER, minScore: "2" })).toEqual({});
    expect(bulkFilter({}, { ...EMPTY_BULK_FILTER, minVerifiability: "0.5", maxVerifiability: "x", untestedOnly: true })).toEqual({ minVerifiability: 0.5, untested: true });
    expect(bulkFilter({}, { ...EMPTY_BULK_FILTER, minScore: "abc" })).toEqual({});
  });

  it("counts only rows each verb would actually change, and recommended pending ones", () => {
    const c = bulkCounts(lessons, { slug: "o/web" });
    expect(c.matched).toBe(5);
    expect(c.verbs).toEqual({ confirm: 2, reject: 5, disable: 2, enable: 1, delete: 5 });
    expect(c.recommended).toBe(1);
    expect(bulkCounts(lessons, { minScore: 0.6 }).verbs.confirm).toBe(1);
    expect(bulkCounts(lessons, { degraded: true }).verbs.disable).toBe(1);
  });

  it("keeps delete off rejected rows unless a status was picked", () => {
    expect(verbFilter("delete", { slug: "a" })).toEqual({ slug: "a", status: ["pending", "confirmed", "disabled"] });
    expect(verbFilter("delete", { status: ["pending"] })).toEqual({ status: ["pending"] });
    expect(verbFilter("confirm", {})).toEqual({});
  });

  it("asks for a second click on delete and on an empty filter", () => {
    expect(needsSecondClick("delete", { slug: "a" })).toBe(true);
    expect(needsSecondClick("confirm", {})).toBe(true);
    expect(needsSecondClick("accept_recommended", {})).toBe(true);
    expect(needsSecondClick("confirm", { slug: "a" })).toBe(false);
  });

  it("keeps only picks that are still pending", () => {
    expect(livePicked([1, 3, 9], [lesson(1), lesson(2)])).toEqual([1]);
  });
});

describe("lessonTags", () => {
  it("shows filled fields only", () => {
    expect(lessonTags(lesson(1), S)).toEqual([]);
    const tags = lessonTags(lesson(2, { admission: "shelved", shelvedReason: "low_score", strength: "must", checkability: "prose", score: 0.456, degraded: true, degradedFrom: "big" }), S);
    expect(tags.map((t) => t.text)).toEqual(["Shelved · Low score", "Must", "Prose only", "Score 0.46", "Fallback model"]);
    expect(tags.find((t) => t.key === "degraded")?.title).toContain("big");
    expect(lessonTags(lesson(3, { admission: "auto" }), S)[0]).toMatchObject({ text: "Recommended", tone: "ok" });
    expect(lessonTags(lesson(4, { admission: "shelved", shelvedReason: "something_new" }), STRINGS.zh)[0].text).toBe("已搁置 · something_new");
  });
});

describe("import preview choices", () => {
  const row = (status: PreviewRow["status"], fingerprint = "a".repeat(16), localId: number | null = 1): PreviewRow => ({ fingerprint, label: "x", status, diffs: [], reasons: [], localId });

  it("mirrors the main-process defaults", () => {
    expect(effectiveResolution("lessons", row("added"), "merge", undefined, {})).toBe("imported");
    expect(effectiveResolution("lessons", row("changed"), "merge", undefined, {})).toBe("local");
    expect(effectiveResolution("lessons", row("changed"), "replace", undefined, {})).toBe("imported");
    expect(effectiveResolution("lessons", row("conflicting"), "merge", "imported", {})).toBe("imported");
    expect(effectiveResolution("lessons", row("conflicting"), "merge", "imported", { [`lessons:${"a".repeat(16)}`]: "local" })).toBe("local");
  });

  it("lets you choose changed and conflicting rows, and removed rows only when replacing", () => {
    expect(rowChoosable(row("changed"), "merge")).toBe(true);
    expect(rowChoosable(row("added"), "replace")).toBe(false);
    expect(rowChoosable(row("removed"), "merge")).toBe(false);
    expect(rowChoosable(row("removed"), "replace")).toBe(true);
    expect(rowChoosable(row("removed", "b".repeat(16), null), "replace")).toBe(false);
  });

  it("a bulk choice also decides removed rows when replacing", () => {
    const counts = { added: 0, changed: 0, conflicting: 0, unchanged: 0, removed: 1 };
    const p: ImportPreview = {
      token: "t", starter: false, skippedSections: [], totals: counts,
      file: { exportedAt: 0, butlerVersion: "3.0.0", formatVersion: 1, scope: { kind: "all" }, includeSourceUrls: false },
      sections: [{ id: "lessons", counts, rows: [row("removed"), row("changed", "c".repeat(16))] }],
    };
    expect(applyBulkResolution(p, "replace", "local")).toEqual({ [`lessons:${"a".repeat(16)}`]: "local" });
    expect(applyBulkResolution(p, "merge", "local")).toEqual({});
  });

  it("writes diff values on one line", () => {
    expect(diffValue(null, "-")).toBe("-");
    expect(diffValue([], "-")).toBe("-");
    expect(diffValue(["a", "b"], "-")).toBe("a, b");
    expect(diffValue({ a: 1 }, "-")).toBe('{"a":1}');
    expect(diffValue(3, "-")).toBe("3");
  });
});

describe("batches and backups", () => {
  it("titles batches, including undo batches and unknown kinds", () => {
    expect(batchTitle({ kind: "confirm", entity: "lesson", summary: {} }, S)).toBe("Confirm");
    expect(batchTitle({ kind: "policy", entity: "policy", summary: {} }, S)).toBe("Admission policy change · Admission policy");
    expect(batchTitle({ kind: "undo", entity: "lesson", summary: { kind: "import" } }, S)).toBe("Undo: Import");
    expect(batchTitle({ kind: "undo", entity: "lesson", summary: { kind: "import" } }, STRINGS.zh)).toBe("撤销：导入");
    expect(batchTitle({ kind: "new_thing", entity: "lesson", summary: {} }, S)).toBe("new_thing");
  });
  it("reads the backup kind from the file name", () => {
    expect(backupKind("auto-2026-01-01T00-00-00.000Z.json")).toBe("auto");
    expect(backupKind("before-replace-2026.json")).toBe("before-replace");
    expect(backupKind("manual-2026.json")).toBe("manual");
  });
});

describe("bulk filter numbers", () => {
  it("passes shelved reason, score range, minimum hits and batch through, ignoring bad input", () => {
    expect(bulkFilter({}, { ...EMPTY_BULK_FILTER, shelvedReason: ["conflict"], maxScore: "0.5", minHits: "3", batchId: "7" })).toEqual({ shelvedReason: ["conflict"], maxScore: 0.5, minHits: 3, batchId: 7 });
    expect(bulkFilter({}, { ...EMPTY_BULK_FILTER, minHits: "1.5", batchId: "0", maxScore: "-1" })).toEqual({});
  });
});

describe("review fixes (renderer)", () => {
  const row = (local: string, incoming: string): PreviewRow => ({ fingerprint: "0123456789abcdef", label: "x", status: "conflicting", diffs: [{ field: "status", local, incoming }], reasons: ["status"], localId: 3 });
  it("flags an import that would confirm a lesson only when the imported version is used", () => {
    expect(confirmsLesson("lessons", row("pending", "confirmed"), "imported")).toBe(true);
    expect(confirmsLesson("lessons", row("rejected", "confirmed"), "imported")).toBe(true);
    expect(confirmsLesson("lessons", row("pending", "confirmed"), "local")).toBe(false);
    expect(confirmsLesson("lessons", row("confirmed", "disabled"), "imported")).toBe(false);
    expect(confirmsLesson("products", row("pending", "confirmed"), "imported")).toBe(false);
  });
  it("maxLessonId is the largest id the page has seen", () => {
    expect(maxLessonId([])).toBe(0);
    expect(maxLessonId([{ id: 4 }, { id: 9 }, { id: 2 }] as Lesson[])).toBe(9);
  });
});
