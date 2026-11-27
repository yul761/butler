import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { presetWorkflow, type FeatureWorkflowView, type TicketWorkflowView, type WorkflowSettingsView as View } from "../../../shared/workflow";
import { S, setUiLang } from "../strings";
import { FeatureWorkflowStrip, TicketWorkflowStrip, WorkflowEditor, WorkflowSettingsView } from "./WorkflowParts";

const h = vi.hoisted(() => ({ open: vi.fn(), errors: [] as unknown[] }));
vi.mock("../api", () => ({ api: { openShipherdSession: h.open } }));
vi.mock("../errors", () => ({ reportError: (e: unknown) => h.errors.push(e) }));

afterEach(() => {
  setUiLang("zh");
  h.open.mockReset();
  h.errors.length = 0;
});

const ticketView = (p: Partial<TicketWorkflowView> = {}): TicketWorkflowView => ({
  ticketKey: "A-1",
  workflow: presetWorkflow("fast"),
  source: { scope: { kind: "feature", featureId: 4 }, label: "4.3.0" },
  preset: "fast",
  steps: [
    { id: "implement", state: "done", doneAt: 1, detail: null },
    { id: "open_pr", state: "current", doneAt: null, detail: null },
    { id: "ci_green", state: "todo", doneAt: null, detail: null },
    { id: "merge", state: "todo", doneAt: null, detail: null },
  ] as TicketWorkflowView["steps"],
  current: "open_pr",
  ...p,
});

describe("workflow strips (BTL-273)", () => {
  it("the ticket strip marks done and current, and names where the workflow comes from", () => {
    const html = renderToStaticMarkup(createElement(TicketWorkflowStrip, { view: ticketView() }));
    expect(html).toContain('data-step="implement" data-state="done"');
    expect(html).toContain('data-step="open_pr" data-state="current"');
    expect(html).toContain(`${S.workflow.current}${S.workflow.steps.open_pr}`);
    expect(html).toContain("按epic · 4.3.0");
  });

  it("draws nothing without a workflow, and says all done at the end", () => {
    expect(renderToStaticMarkup(createElement(TicketWorkflowStrip, { view: null }))).toBe("");
    expect(renderToStaticMarkup(createElement(TicketWorkflowStrip, { view: ticketView({ workflow: null, source: null, steps: [], current: null }) }))).toBe("");
    expect(renderToStaticMarkup(createElement(TicketWorkflowStrip, { view: ticketView({ current: null }) }))).toContain(S.workflow.allDone);
  });

  it("the epic strip shows its own workflow or says it inherits, plus each ticket", () => {
    const own: FeatureWorkflowView = { featureId: 4, own: presetWorkflow("fast"), tickets: [{ key: "A-1", current: "ci_green", done: 2, total: 4 }] };
    const html = renderToStaticMarkup(createElement(FeatureWorkflowStrip, { view: own }));
    expect(html).toContain(S.workflow.epicOwn);
    expect(html).toContain("A-1");
    expect(html).toContain("2/4");
    expect(renderToStaticMarkup(createElement(FeatureWorkflowStrip, { view: { ...own, own: null } }))).toContain(S.workflow.epicInherit);
    expect(renderToStaticMarkup(createElement(FeatureWorkflowStrip, { view: { featureId: 4, own: null, tickets: [] } }))).toBe("");
  });

  it("in English the copy has no Chinese", () => {
    setUiLang("en");
    const html = renderToStaticMarkup(createElement(TicketWorkflowStrip, { view: ticketView({ source: { scope: { kind: "global" }, label: "" } }) }));
    expect(/[一-鿿]/.test(html)).toBe(false);
  });
});

describe("workflow settings (BTL-273)", () => {
  const view = (p: Partial<View> = {}): View => ({
    layers: [{ scope: { kind: "global" }, label: "", workflow: presetWorkflow("strict"), updatedAt: 1 }],
    targets: { products: [{ id: 9, name: "Shipherd" }], repos: ["o/a"], features: [{ id: 4, name: "4.3.0" }], tickets: [{ key: "A-1", title: "可配置流程" }] },
    ...p,
  });
  const settings = (v: View) => renderToStaticMarkup(createElement(WorkflowSettingsView, { view: v, onSet: async () => ({ ok: true as const, changed: true }), onAskClaude: () => {} }));

  it("lists each layer with its preset and steps, and offers to set it up with Claude", () => {
    const html = settings(view());
    expect(html).toContain('data-testid="workflow-ask-claude"');
    expect(html).toContain('data-scope="global"');
    expect(html).toContain(S.workflow.presetName.strict);
    expect(html).toContain(`data-step="pre_review"`);
    expect(html).toContain('data-testid="workflow-add-kind"');
  });

  it("says nothing is set when there are no layers", () => {
    expect(settings(view({ layers: [] }))).toContain(S.workflow.none);
  });

  it("the editor shows only the options a step uses, and the save error", () => {
    const html = renderToStaticMarkup(createElement(WorkflowEditor, {
      initial: { steps: [{ id: "implement" }, { id: "open_pr", draft: true }, { id: "re_review", maxRounds: 3 }, { id: "merge", mergeBy: "user" }], notes: "" },
      busy: false, error: "顺序不对", onSave: () => {}, onCancel: () => {},
    }));
    expect(html).toContain(S.workflow.draft);
    expect(html).toContain(S.workflow.rounds);
    expect(html).toContain('data-testid="workflow-merge-by"');
    expect(html).toContain("顺序不对");
    // 已经有的步骤不在「加一步」里
    expect(html).not.toContain('data-testid="workflow-add-merge"');
    expect(html).toContain('data-testid="workflow-add-ci_green"');
    expect(html).toContain(S.workflow.custom);
  });
});

describe("set it up with Claude (BTL-273)", () => {
  it("opens the Shipherd coordinator with the prefill and focuses the terminal it returns", async () => {
    const { askClaude } = await import("./SettingsPage");
    h.open.mockResolvedValue({ ok: true, termId: "t-new", alreadyOpen: true });
    const opened: string[] = [];
    await askClaude((id) => opened.push(id));
    expect(h.open).toHaveBeenCalledWith({ prefill: S.workflow.prefill });
    // 已经开着一个总控：也聚焦这次返回的那个终端
    expect(opened).toEqual(["t-new"]);
    expect(h.errors).toEqual([]);
  });

  it("says why when it can't open", async () => {
    const { askClaude } = await import("./SettingsPage");
    h.open.mockResolvedValue({ ok: false, reason: "no_repo" });
    const opened: string[] = [];
    await askClaude((id) => opened.push(id));
    expect(opened).toEqual([]);
    expect(String(h.errors[0])).toContain(S.shipherdOpenErrors.no_repo);
  });
});
