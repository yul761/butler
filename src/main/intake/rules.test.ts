import { describe, expect, it } from "vitest";
import type { IncomingTicket } from "../../shared/intake";
import { defaultPrPolicy } from "../../shared/pr-policy";
import { classifyByRules, clarifyQuestions, extractPaths } from "./rules";

const risk = defaultPrPolicy().risk;
const AC = "Acceptance criteria:\n- [ ] the button is blue\n- [ ] the label reads Save";
const t = (o: Partial<IncomingTicket> = {}): IncomingTicket => ({
  key: "PROJ-1", title: "Change button colour", description: `Make the save button blue on the settings screen.\n${AC}`, type: "Story", labels: [],
  priority: null, url: null, storyPoints: null, components: [], subtasks: [], repo: null, ...o,
});

describe("extractPaths", () => {
  it("finds files and directories, normalises separators and skips urls", () => {
    expect(extractPaths("Edit `src/ui/Button.tsx` and src\\lib\\util.ts, see https://example.com/a/b and README.md.")).toEqual([
      "src/ui/Button.tsx", "src/lib/util.ts", "README.md",
    ]);
    expect(extractPaths("Look in ./docs/ and db/migrations/")).toEqual(["docs/", "db/migrations/"]);
    expect(extractPaths("on 2024/05/01 and/or 3/4")).toEqual(["and/or"]);
    expect(extractPaths("plain words only")).toEqual([]);
  });
});

describe("classifyByRules", () => {
  it("a complete small low-risk ticket decides every dimension", () => {
    const r = classifyByRules(t({ storyPoints: 1, description: `Change docs/guide.md wording for clarity on save.\n${AC}` }), risk);
    expect(r).toMatchObject({ size: "small", risk: "low", clarify: false, missing: [], undecided: [] });
    expect(r.expectedPaths).toEqual(["docs/guide.md"]);
  });

  it("a feature without acceptance criteria needs clarification", () => {
    const r = classifyByRules(t({ description: "Please make the save button blue so it stands out more on the settings screen." }), risk);
    expect(r.clarify).toBe(true);
    expect(r.missing).toEqual(["acceptance_criteria"]);
  });

  it("recognises Chinese acceptance criteria and given/when/then", () => {
    expect(classifyByRules(t({ description: "把设置页的保存按钮改成蓝色，和别的按钮保持一致。\n验收标准：按钮是蓝色的" }), risk).clarify).toBe(false);
    expect(classifyByRules(t({ description: "Given a user on settings, when they look at save, then the button is blue and readable." }), risk).clarify).toBe(false);
  });

  it("a short description is missing", () => {
    expect(classifyByRules(t({ description: "fix it" }), risk).missing).toContain("description");
  });

  it("a bug without repro steps needs clarification; with steps it does not", () => {
    const bug = { type: "Bug", description: "The save button crashes the app when the settings screen has unsaved changes in it." };
    expect(classifyByRules(t(bug), risk).missing).toEqual(["repro_steps"]);
    expect(classifyByRules(t({ ...bug, description: `${bug.description}\nSteps to reproduce:\n1. open settings\n2. click save` }), risk).clarify).toBe(false);
    expect(classifyByRules(t({ type: null, labels: ["bug"], description: "保存时崩溃，设置页有未保存的修改时一点保存按钮就崩。复现步骤：打开设置" }), risk).clarify).toBe(false);
  });

  it("size: story points, subtasks and labels", () => {
    expect(classifyByRules(t({ storyPoints: 3 }), risk).size).toBe("medium");
    expect(classifyByRules(t({ storyPoints: 8 }), risk).size).toBe("large");
    const subtasks = [1, 2, 3].map((i) => ({ key: `PROJ-${10 + i}`, title: `part ${i}` }));
    expect(classifyByRules(t({ storyPoints: 1, subtasks }), risk).size).toBe("large");
    expect(classifyByRules(t({ labels: ["typo"] }), risk).size).toBe("small");
    expect(classifyByRules(t({ labels: ["Epic"] }), risk).size).toBe("large");
    expect(classifyByRules(t({ type: "Chore" }), risk).size).toBe("small");
    expect(classifyByRules(t(), risk).undecided).toContain("size");
  });

  it("risk: G's risk paths, keywords, type floors and priority", () => {
    expect(classifyByRules(t({ description: `Add a column in db/migrations/0042_add.sql for the save flag.\n${AC}` }), risk).risk).toBe("high");
    expect(classifyByRules(t({ description: `Touch .github/workflows/ci.yml to cache deps.\n${AC}` }), risk).risk).toBe("high");
    expect(classifyByRules(t({ title: "Rework permissions for admins" }), risk).risk).toBe("high");
    expect(classifyByRules(t({ title: "调整支付回调" }), risk).risk).toBe("high");
    expect(classifyByRules(t({ labels: ["hotfix"] }), risk).risk).toBe("high");
    expect(classifyByRules(t({ type: "Bug", description: "Crash on save. Steps to reproduce: 1. open settings 2. click save button" }), risk).risk).toBe("medium");
    expect(classifyByRules(t({ priority: "Highest" }), risk).risk).toBe("medium");
    expect(classifyByRules(t({ description: `Add tests in src/ui/Button.test.tsx for the save flow.\n${AC}` }), risk).risk).toBe("low");
    const r = classifyByRules(t(), risk);
    expect(r.risk).toBeNull();
    expect(r.undecided).toEqual(["size", "risk"]);
  });

  it("records why", () => {
    const r = classifyByRules(t({ storyPoints: 1 }), risk);
    expect(r.reasons).toContainEqual({ dim: "size", rule: "story_points", detail: "1" });
    expect(r.reasons).toContainEqual({ dim: "clarify", rule: "complete", detail: "feature" });
  });
});

describe("clarifyQuestions", () => {
  it("one question per missing item in either language", () => {
    expect(clarifyQuestions(["acceptance_criteria", "repro_steps"], "en")).toHaveLength(2);
    expect(clarifyQuestions(["description"], "zh")[0]).toMatch(/描述/);
  });
});
