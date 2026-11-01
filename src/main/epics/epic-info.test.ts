import { describe, expect, it } from "vitest";
import type { FeatureHandoff } from "../../shared/handoff";
import type { EpicFeatureRow } from "../../shared/types";
import { EpicsRepo } from "../db/epics-repo";
import { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import { FeaturesRepo } from "../db/features-repo";
import { memDb } from "../test-utils";
import { carriedEpicPlan, epicFeatureRows, EPIC_HANDOFF_MAX_CHARS, EPIC_PLAN_MAX_CHARS, newestSummaryFirst, renderEpicHandoff, rowSections, type LiveFeature } from "./epic-info";

const summary = (over: Partial<FeatureHandoff> = {}): FeatureHandoff => ({
  summary: "接口联调完了", blockers: [], next_steps: [], decisions: [], open_questions: [], ...over,
});

function setup() {
  const db = memDb();
  const epics = new EpicsRepo(db);
  const features = new FeaturesRepo(db);
  const featureHandoffs = new FeatureHandoffsRepo(db);
  const epicId = epics.insert({ name: "E", workspaceDir: "/e", createdAt: 1 });
  const live = new Map<number, LiveFeature>();
  const add = (name: string, l?: LiveFeature) => {
    const id = features.insert({ name, workspaceDir: `/w/${name}`, createdAt: 1 });
    features.setEpic(id, epicId);
    if (l) live.set(id, l);
    return id;
  };
  const addSummary = (featureId: number, p: FeatureHandoff | null, createdAt: number) =>
    featureHandoffs.insert({ featureId, sessionId: null, trigger: "nightly", createdAt, payload: p, rawText: null });
  const rows = () => epicFeatureRows(epicId, { features, latestValid: (id) => featureHandoffs.latestValid(id), live: (id) => live.get(id) });
  return { epicId, features, add, addSummary, rows };
}

const byName = (rows: EpicFeatureRow[], name: string) => rows.find((r) => r.name === name)!;

describe("epicFeatureRows", () => {
  it("picks the status by priority: stuck > waiting > not started > active", () => {
    const t = setup();
    t.add("both", { stuck: true, waiting: true, started: true });
    t.add("waits", { stuck: false, waiting: true, started: true });
    t.add("fresh", { stuck: false, waiting: false, started: false });
    t.add("busy", { stuck: false, waiting: false, started: true });
    t.add("nolive");
    const rows = t.rows();
    expect(Object.fromEntries(rows.map((r) => [r.name, r.status]))).toEqual({
      both: "stuck", waits: "waiting", fresh: "not_started", busy: "active", nolive: "not_started",
    });
  });

  it("lists archived features marked archived, after the live ones", () => {
    const t = setup();
    const old = t.add("old", { stuck: true, waiting: false, started: true });
    t.add("now", { stuck: false, waiting: false, started: true });
    t.features.archive(old, 50);
    const rows = t.rows();
    expect(rows.map((r) => r.name)).toEqual(["now", "old"]);
    expect(byName(rows, "old")).toMatchObject({ status: "archived", archivedAt: 50 });
  });

  it("uses empty fields without throwing when there is no valid summary", () => {
    const t = setup();
    const a = t.add("a");
    t.addSummary(a, null, 5);
    expect(t.rows()[0]).toMatchObject({ summaryAt: null, summary: null, blockers: [], decisions: [], openQuestions: [] });
  });

  it("takes the latest valid summary and orders each group by it, newest first", () => {
    const t = setup();
    const a = t.add("a");
    const b = t.add("b");
    t.add("c");
    t.addSummary(a, summary({ summary: "a1" }), 10);
    t.addSummary(a, summary({ summary: "a2", blockers: ["等 b"], decisions: [{ key: "k", statement: "s" }], open_questions: ["q"] }), 20);
    t.addSummary(a, null, 30);
    t.addSummary(b, summary({ summary: "b1" }), 25);
    const rows = t.rows();
    expect(rows.map((r) => r.name)).toEqual(["b", "a", "c"]);
    expect(byName(rows, "a")).toMatchObject({ summary: "a2", summaryAt: 20, blockers: ["等 b"], decisions: [{ key: "k", statement: "s" }], openQuestions: ["q"] });
  });

  it("reuses the summary of the live data when it is valid and asks the repo otherwise", () => {
    const t = setup();
    const a = t.add("a", {
      stuck: false, waiting: false, started: true,
      summary: { id: 1, featureId: 0, sessionId: null, trigger: "nightly", createdAt: 7, coversUntil: null, payload: summary({ summary: "live" }), degraded: false, rawText: null, sourceRef: null },
    });
    expect(t.rows()[0]).toMatchObject({ summary: "live", summaryAt: 7 });
    t.addSummary(a, summary({ summary: "db" }), 3);
    const d = setup();
    const b = d.add("b", { stuck: false, waiting: false, started: true, summary: { id: 1, featureId: 0, sessionId: null, trigger: "nightly", createdAt: 9, coversUntil: null, payload: null, degraded: true, rawText: "x", sourceRef: null } });
    d.addSummary(b, summary({ summary: "valid" }), 3);
    expect(d.rows()[0]).toMatchObject({ summary: "valid", summaryAt: 3 });
  });
});

const row = (id: number, over: Partial<EpicFeatureRow> = {}): EpicFeatureRow => ({
  id, name: `F${id}`, status: "active", archivedAt: null, summaryAt: id, summary: `summary ${id}`, blockers: [], decisions: [], openQuestions: [], ...over,
});

describe("the row parts shared with the first message", () => {
  const titles = { blockers: "B:", decisions: "D:", questions: "Q:" };
  const base = { id: 1, name: "F", status: "active", archivedAt: null, summaryAt: null, summary: null, blockers: [], decisions: [], openQuestions: [] } satisfies EpicFeatureRow;

  it("lists blockers, decisions and open questions in order, with the given titles", () => {
    const r = { ...base, blockers: ["b1"], decisions: [{ key: "k", statement: "s" }], openQuestions: ["q1", "q2"] };
    expect(rowSections(r, titles)).toEqual(["B:", "- b1", "D:", "- k: s", "Q:", "- q1", "- q2"]);
  });

  it("leaves out an empty section", () => {
    expect(rowSections(base, titles)).toEqual([]);
    expect(rowSections({ ...base, openQuestions: ["q"] }, titles)).toEqual(["Q:", "- q"]);
  });

  it("sorts the newest summary first and features without one last, keeping ties in order", () => {
    const rows = [{ ...base, id: 1 }, { ...base, id: 2, summaryAt: 5 }, { ...base, id: 3, summaryAt: 9 }, { ...base, id: 4 }];
    expect([...rows].sort(newestSummaryFirst).map((r) => r.id)).toEqual([3, 2, 1, 4]);
  });
});

describe("renderEpicHandoff", () => {
  it("renders name, status, progress, blockers, decisions and questions in the language asked", () => {
    const r = row(1, { status: "archived", archivedAt: 5, blockers: ["等后端"], decisions: [{ key: "api", statement: "走 REST" }], openQuestions: ["拆 PR 吗"] });
    const zh = renderEpicHandoff([r], "zh");
    expect(zh).toContain("## F1 (已归档)");
    // 状态变了不会重新同步：进行中、卡住、等回话不写进正文。
    for (const status of ["active", "stuck", "waiting", "not_started"] as const) {
      expect(renderEpicHandoff([row(2, { status })], "zh")).toContain("## F2\n");
    }
    expect(zh).toContain("summary 1");
    expect(zh).toContain("- 等后端");
    expect(zh).toContain("- api: 走 REST");
    expect(zh).toContain("- 拆 PR 吗");
    expect(renderEpicHandoff([r], "en")).toContain("## F1 (archived)");
    expect(renderEpicHandoff([row(2, { summary: null })], "en")).toContain("No summary yet");
    expect(renderEpicHandoff([], "en")).toContain("no features");
  });

  it("keeps only the 10 most recent features", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i + 1));
    const out = renderEpicHandoff(rows, "zh");
    expect(out).toContain("## F12\n");
    expect(out).toContain("## F3\n");
    expect(out).not.toContain("## F2\n");
    expect(out).not.toContain("## F1\n");
  });

  it("drops the oldest features first when the text is too long, and never exceeds the cap", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, { summary: `${"x".repeat(1500)}#${i + 1}` }));
    const out = renderEpicHandoff(rows, "en");
    expect(out.length).toBeLessThanOrEqual(EPIC_HANDOFF_MAX_CHARS);
    expect(out).toContain("## F10\n");
    expect(out).not.toContain("## F1\n");
    expect(renderEpicHandoff([row(1, { summary: "y".repeat(20000) })], "en").length).toBe(EPIC_HANDOFF_MAX_CHARS);
  });
});

describe("the epic session's own handoff inside the rendered text", () => {
  const INTRO = { zh: renderEpicHandoff([row(1)], "zh").split("\n\n")[0], en: renderEpicHandoff([row(1)], "en").split("\n\n")[0] };

  it("puts the plan after the intro and before the features", () => {
    const out = renderEpicHandoff([row(1)], "zh", "先做支付");
    expect(out.startsWith(INTRO.zh)).toBe(true);
    expect(out.indexOf("先做支付")).toBeLessThan(out.indexOf("## F1\n"));
  });

  it("takes a handoff that is not Butler's as the plan, whole", () => {
    expect(carriedEpicPlan("  先做支付\nNext steps:\n- 拆 ticket\n")).toBe("先做支付\nNext steps:\n- 拆 ticket");
  });

  it("finds nothing to carry in Butler's own text, in either language", () => {
    for (const lang of ["zh", "en"] as const) {
      expect(carriedEpicPlan(renderEpicHandoff([row(1)], lang))).toBeNull();
      // 移出最后一个 feature 之后的正文也是 Butler 自己的。
      expect(carriedEpicPlan(renderEpicHandoff([], lang))).toBeNull();
    }
  });

  it("reads the plan back out of a rendered text, in either language, without the features", () => {
    for (const lang of ["zh", "en"] as const) expect(carriedEpicPlan(renderEpicHandoff([row(1)], lang, "先做支付\n\n## 看起来像 feature"))).toBe("先做支付\n\n## 看起来像 feature");
  });

  it("does not grow or nest when it is carried again and again", () => {
    const once = renderEpicHandoff([row(1)], "zh", "先做支付");
    let out = once;
    for (let i = 0; i < 3; i++) out = renderEpicHandoff([row(1)], "zh", carriedEpicPlan(out));
    expect(out).toBe(once);
    // 换语言也一样：只换 intro。
    expect(carriedEpicPlan(renderEpicHandoff([row(1)], "en", carriedEpicPlan(once)))).toBe("先做支付");
  });

  it("keeps a plan with no features left, and ignores a blank one", () => {
    const out = renderEpicHandoff([], "en", "first the payments");
    expect(out).toContain("no features");
    expect(carriedEpicPlan(out)).toBe("first the payments");
    expect(renderEpicHandoff([row(1)], "en", "  ")).toBe(renderEpicHandoff([row(1)], "en"));
  });

  it("is not fooled by a plan that quotes the whole rendered text, or by a feature that looks like the section", () => {
    const quoted = `我抄了一份：\n${renderEpicHandoff([row(1)], "zh", "旧规划")}\n后面还有字`;
    const out = renderEpicHandoff([row(1)], "zh", carriedEpicPlan(quoted));
    expect(carriedEpicPlan(out)).toContain("后面还有字");
    expect(renderEpicHandoff([row(1)], "zh", carriedEpicPlan(out))).toBe(out);
    const tag = renderEpicHandoff([], "zh", "x").split("\n")[2];
    expect(carriedEpicPlan(renderEpicHandoff([row(1, { summary: tag })], "zh"))).toBeNull();
  });

  it("stays inside the cap: a long plan is cut, leaves room for the newest feature, and stops shrinking", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, { summary: `${"x".repeat(1500)}#${i + 1}` }));
    const out = renderEpicHandoff(rows, "en", "p".repeat(20000));
    expect(out.length).toBeLessThanOrEqual(EPIC_HANDOFF_MAX_CHARS);
    expect(out).toContain("## F10\n");
    expect(out).not.toContain("## F9\n");
    const plan = carriedEpicPlan(out)!;
    expect(plan.length).toBeLessThanOrEqual(EPIC_PLAN_MAX_CHARS);
    expect(plan.startsWith("ppp")).toBe(true);
    expect(renderEpicHandoff(rows, "en", plan)).toBe(out);
  });

  it("drops the oldest features to make room for a plan that fits", () => {
    const rows = Array.from({ length: 4 }, (_, i) => row(i + 1, { summary: `${"x".repeat(1500)}#${i + 1}` }));
    expect(renderEpicHandoff(rows, "en")).toContain("## F1\n");
    const out = renderEpicHandoff(rows, "en", "p".repeat(5000));
    expect(out).toContain("p".repeat(5000));
    expect(out).toContain("## F4\n");
    expect(out).not.toContain("## F1\n");
    expect(out.length).toBeLessThanOrEqual(EPIC_HANDOFF_MAX_CHARS);
  });
});
