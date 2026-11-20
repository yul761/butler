import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { S } from "../strings";
import { AuditEmptyNote, ExternalAudit } from "./AuditPage";
import { EffectAutomationTab } from "./EffectPage";
import { LessonsAttention } from "./LessonsPage";

describe("LessonsAttention", () => {
  it("says how many new rules wait and offers the review button", () => {
    const html = renderToStaticMarkup(createElement(LessonsAttention, { count: 4, onOpen: () => {} }));
    expect(html).toContain("4 条新规矩等你看一眼");
    expect(html).toContain(S.lay.lessonsAttention(4));
    expect(html).toContain('data-testid="lessons-attention"');
    expect(html).toContain('data-testid="lessons-attention-open"');
    expect(html).toContain(S.lay.lessonsReview);
  });
  it("renders nothing at 0", () => {
    expect(renderToStaticMarkup(createElement(LessonsAttention, { count: 0, onOpen: () => {} }))).toBe("");
  });
});

describe("AuditEmptyNote", () => {
  it("explains that Butler does nothing outside by default", () => {
    expect(renderToStaticMarkup(createElement(AuditEmptyNote))).toContain("Butler 默认不替你对外做任何事");
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
