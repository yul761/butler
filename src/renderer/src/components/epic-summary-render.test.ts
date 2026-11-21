import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EpicFeatureRow } from "../../../shared/types";
import { S } from "../strings";
import { EpicSummaryTab } from "./EpicSummaryTab";

const row = (over: Partial<EpicFeatureRow> = {}): EpicFeatureRow => ({
  id: 1, name: "支付方式", status: "active", archivedAt: null, summaryAt: null, summary: null, blockers: [], decisions: [], openQuestions: [], ...over,
});
const render = (rows: EpicFeatureRow[]) => renderToStaticMarkup(createElement(EpicSummaryTab, { rows, onRun: async () => ({ text: "", bad: false }) }));
const at = new Date(2026, 10, 3, 9, 5).getTime();
const when = new Date(at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

describe("EpicSummaryTab", () => {
  it("gives each feature its own section: name, summary, time and every blocker", () => {
    const html = render([
      row({ id: 1, name: "支付方式", summary: "接口写完。前端联调中。", summaryAt: at, blockers: ["等设计稿", "CI 不稳"] }),
      row({ id: 2, name: "退款", summary: "刚开始。", summaryAt: at }),
    ]);
    expect(html.match(/<section class="epic-summary"/g)).toHaveLength(2);
    expect(html).toContain("支付方式");
    expect(html).toContain("接口写完。前端联调中。");
    expect(html).toContain(when);
    expect(html).toContain(S.labelled(S.featureBlocked, "等设计稿"));
    expect(html).toContain(S.labelled(S.featureBlocked, "CI 不稳"));
    expect(html.indexOf("支付方式")).toBeLessThan(html.indexOf("退款"));
  });

  it("says there is no summary yet for a feature that has none, and shows no time", () => {
    const html = render([row()]);
    expect(html).toContain("还没有状态");
    expect(html).not.toContain("summary-at");
  });

  it("has one update-now button per feature, and no whole-epic summary", () => {
    const html = render([row({ id: 1 }), row({ id: 2, name: "退款" })]);
    expect(S.runFeatureSummary).toBe("立即更新");
    expect(html.match(new RegExp(`>${S.runFeatureSummary}</button>`, "g"))).toHaveLength(2);
  });

  it("with no features says so", () => {
    expect(render([])).toContain(S.noEpicFeatures);
  });

  it("leaves out archived features", () => {
    const html = render([row({ id: 1, name: "支付方式" }), row({ id: 2, name: "老功能", status: "archived", archivedAt: 1 })]);
    expect(html).not.toContain("老功能");
    expect(html.match(/<section class="epic-summary"/g)).toHaveLength(1);
    expect(render([row({ status: "archived", archivedAt: 1 })])).toContain(S.noEpicFeatures);
  });
});
