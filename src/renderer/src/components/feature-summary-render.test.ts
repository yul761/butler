import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureHandoffRecord } from "../../../shared/types";
import { S } from "../strings";
import { FeatureSummaryTab, type FeatureSummaryFeature } from "./FeatureSummaryTab";

const at = new Date(2026, 10, 3, 9, 5).getTime();
const when = new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const record = (over: Partial<FeatureHandoffRecord> = {}): FeatureHandoffRecord => ({
  id: 1, featureId: 7, sessionId: null, trigger: "manual", createdAt: at, coversUntil: null, degraded: false, rawText: null, sourceRef: null, prStatusAt: null,
  payload: { summary: "接口写完，前端联调中。", blockers: ["等设计稿"], next_steps: [{ ticket: "K-1", text: "补测试" }, { ticket: "K-9", text: "已归档的" }], decisions: [], open_questions: [] },
  ...over,
});
const feature = (over: Partial<FeatureSummaryFeature> = {}): FeatureSummaryFeature => ({ id: 7, summary: record(), brief: null, tickets: [{ key: "K-1" }], ...over });
const render = (f: FeatureSummaryFeature) =>
  renderToStaticMarkup(createElement(FeatureSummaryTab, { feature: f, onOpenTicket: () => {}, onRun: async () => ({ text: "", bad: false }) }));

describe("FeatureSummaryTab", () => {
  // 规划的收起状态读 localStorage：给个空的，免得 Node 报 ExperimentalWarning。
  beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => null }));
  afterEach(() => vi.unstubAllGlobals());

  it("shows the summary, blockers and next steps; only tickets still in the feature are clickable", () => {
    const html = render(feature());
    expect(html).toContain("接口写完，前端联调中。");
    expect(html).toContain(S.labelled(S.featureBlocked, "等设计稿"));
    expect(html).toContain(S.nextSteps);
    expect(html).toContain('<button class="chip">K-1</button>');
    expect(html).toContain('<span class="key">K-9</span>');
  });

  it("keeps the meta line: time · source · PR as-of, and the update-now button", () => {
    const html = render(feature());
    expect(html).toContain(`${when} · ${S.featureSummaryTrigger.manual} · ${S.featureSummaryPrAsOf(when)}`);
    expect(html).toContain(`>${S.runFeatureSummary}</button>`);
  });

  it("has no 'summary may be stale' note any more", () => {
    const html = render(feature());
    expect(html).not.toContain("summary-stale");
    expect(html).not.toContain("汇总之后又有新活动");
  });

  it("says there is no summary yet, and shows the raw text of a degraded one", () => {
    expect(render(feature({ summary: null }))).toContain(S.featureSummaryNone);
    const html = render(feature({ summary: record({ payload: null, degraded: true, rawText: "原文" }) }));
    expect(html).toContain(S.featureSummaryDegraded);
    expect(html).toContain("原文");
  });

  it("keeps the brief", () => {
    const html = render(feature({ brief: "先做接口" }));
    expect(html).toContain(S.featureBrief);
    expect(html).toContain("先做接口");
  });
});
