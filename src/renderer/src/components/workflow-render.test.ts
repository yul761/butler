import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTE_LIMIT, NOTES_LIMIT, presetWorkflow, type Workflow, type FeatureWorkflowView, type TicketWorkflowView, type WorkflowSettingsView as View } from "../../../shared/workflow";
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
  it("says the workflow turned the comment loop on, and that GitHub replies still follow the user's switch (review 12)", () => {
    const fast = renderToStaticMarkup(createElement(TicketWorkflowStrip, { view: ticketView() }));
    expect(fast).not.toContain("workflow-loop-note");
    const strict = renderToStaticMarkup(createElement(TicketWorkflowStrip, { view: ticketView({ workflow: presetWorkflow("strict") }) }));
    expect(strict).toContain("打开了评论闭环");
    expect(strict).toContain("回复 review 评论");
    const editor = renderToStaticMarkup(createElement(WorkflowEditor, { initial: presetWorkflow("strict"), busy: false, error: null, onSave: () => {}, onCancel: () => {} }));
    expect(editor).toContain("workflow-loop-note");
    setUiLang("en");
    const en = renderToStaticMarkup(createElement(TicketWorkflowStrip, { view: ticketView({ workflow: presetWorkflow("strict") }) }));
    expect(en).toContain("Reply to review comments");
  });

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
    expect(html).not.toContain('data-testid="workflow-no-merge"');
    const noMerge = renderToStaticMarkup(createElement(WorkflowEditor, { initial: { steps: [{ id: "implement" }, { id: "open_pr" }], notes: "" }, busy: false, error: null, onSave: () => {}, onCancel: () => {} }));
    expect(noMerge).toContain(S.workflow.noMerge);
  });

  it("over-long text is kept whole, says why, and can't be saved; it isn't cut off by maxLength", () => {
    const render = (w: Workflow) => renderToStaticMarkup(createElement(WorkflowEditor, { initial: w, busy: false, error: null, onSave: () => {}, onCancel: () => {} }));
    const saveDisabled = (html: string) => /<button[^>]*disabled=""[^>]*data-testid="workflow-save"/.test(html);
    const longNotes = "说".repeat(NOTES_LIMIT) + "尾巴";
    const notes = render({ steps: [{ id: "implement" }, { id: "merge" }], notes: longNotes });
    expect(notes).not.toMatch(/maxlength/i);
    expect(notes).toContain(`${longNotes}</textarea>`);
    expect(notes).toContain(S.workflow.tooLong(NOTES_LIMIT + 2, NOTES_LIMIT));
    expect(saveDisabled(notes)).toBe(true);
    // 某一步的要求超长：同样整段留着、说明原因、存不了
    const longNote = "x".repeat(NOTE_LIMIT + 1);
    const step = render({ steps: [{ id: "implement", note: longNote }, { id: "merge" }], notes: "" });
    expect(step).toContain(`value="${longNote}"`);
    expect(step).toContain(S.workflow.tooLong(NOTE_LIMIT + 1, NOTE_LIMIT));
    expect(saveDisabled(step)).toBe(true);
    // 快到上限：显示字数，还能存；短的什么都不显示
    const near = render({ steps: [{ id: "implement", note: "x".repeat(NOTE_LIMIT) }, { id: "merge" }], notes: "" });
    expect(near).toContain(S.workflow.count(NOTE_LIMIT, NOTE_LIMIT));
    expect(saveDisabled(near)).toBe(false);
    expect(render({ steps: [{ id: "implement", note: "短" }, { id: "merge" }], notes: "" })).not.toContain("workflow-length");
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
