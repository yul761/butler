import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { S } from "../strings";
import { AuditEmptyNote, ExternalAudit } from "./AuditPage";
import { EffectAutomationTab } from "./EffectPage";
import { LESSON_FIELD_DEFAULTS, type Lesson } from "../../../shared/lessons";
import { PendingLessons, pendingKey, type PendingLessonsProps } from "./PendingLessons";

describe("PendingLessons (BTL-244: the lessons page's default view)", () => {
  const lesson = (id: number, scope: Lesson["scope"], status: Lesson["status"], o: Partial<Lesson> = {}): Lesson => ({
    id, scope, text: `规矩 ${id}`, why: "", status, hits: 1, lastSeenAt: 1, createdAt: 0, sources: [], ...LESSON_FIELD_DEFAULTS, scopeGlobs: [], ...o,
  });
  const s = {
    products: [{ id: 1, name: "shop", slugs: ["o/web"] }],
    lessons: [
      lesson(1, { kind: "repo", slug: "o/api" }, "pending", { why: "两次 review 都提到", sources: [{ id: 7, prNumber: 52, slug: "o/api" } as Lesson["sources"][number]] }),
      lesson(2, { kind: "repo", slug: "o/api" }, "confirmed"),
      lesson(3, { kind: "product", productId: 1 }, "pending"),
    ],
  };
  const render = (o: Partial<PendingLessonsProps> = {}) =>
    renderToStaticMarkup(createElement(PendingLessons, { s, act: async () => true, error: () => undefined, ...o }));
  it("lists every pending lesson with where it belongs, why, its sources and confirm / edit / reject", () => {
    const html = render();
    expect(html).toContain('data-testid="pending-lesson-1"');
    expect(html).toContain('data-testid="pending-lesson-3"');
    expect(html).not.toContain('data-testid="pending-lesson-2"');
    expect(html).toContain(">o/api</span>");
    expect(html).toContain(">shop</span>");
    expect(html).toContain(S.lessonsWhy("两次 review 都提到"));
    expect(html).toContain(">#52</button>");
    for (const b of [S.lessonsConfirm, S.lessonsEditConfirm, S.lessonsReject]) expect(html).toContain(`>${b}</button>`);
    expect(html).toContain('<span class="count">2</span>');
  });
  it("says so when nothing is pending, and shows an action's error under its lesson", () => {
    expect(render({ s: { products: [], lessons: [] } })).toContain(S.lessonsNoPending);
    expect(render({ error: (k) => (k === pendingKey(3) ? "出错了" : undefined) })).toContain("出错了");
  });
});

describe("AuditEmptyNote", () => {
  it("explains that Shipherd does nothing outside by default", () => {
    expect(renderToStaticMarkup(createElement(AuditEmptyNote))).toContain("Shipherd 默认不替你对外做任何事");
  });
});

describe("ExternalAudit", () => {
  it("keeps its section, heading and the none note when the list is empty", () => {
    const html = renderToStaticMarkup(createElement(ExternalAudit, { entries: [] }));
    expect(html).toContain('data-testid="external-audit"');
    expect(html).toContain(S.externalAuditHeading);
    expect(html).toContain(S.externalAuditNone);
  });
  it("shows only the heading while loading", () => {
    const html = renderToStaticMarkup(createElement(ExternalAudit, { entries: null }));
    expect(html).toContain(S.externalAuditHeading);
    expect(html).not.toContain(S.externalAuditNone);
  });
});

describe("EffectAutomationTab", () => {
  it("shows loading until any of the three sections has data", () => {
    expect(renderToStaticMarkup(createElement(EffectAutomationTab, { loop: null, review: null, intake: null }))).toContain(S.loading);
  });
});
