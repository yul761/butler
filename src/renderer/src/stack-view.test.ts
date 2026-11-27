import { describe, expect, it } from "vitest";
import type { StackLayerView, StackPolicyView, StackView } from "../../shared/stacks";
import { layerActions, lastRunLines, parseStackInput, stackAutoRebaseNote, stackEpicLines, stackKeyKind, stackNoticeText, stackOverridesFromDraft, stackShown } from "./stack-view";
import { STRINGS } from "./strings";

const layer = (id: number, state: StackLayerView["state"]): StackLayerView => ({
  id, position: id, branch: `b${id}`, ticketKey: null, ticketTitle: null, mode: state === "draft" ? "draft" : "branch", state,
  prNumber: null, prUrl: null, behind: null, lastRebaseAt: null, draftSince: null, mergedAt: null, unpushed: false,
});
const stack = (layers: StackLayerView[]): StackView => ({
  id: 1, name: "s", repoPath: "/r", repoSlug: null, trunk: "main", featureId: null, source: "mcp", mergeMethod: null,
  autoRebase: true, autoRebaseBy: "policy", overviewUrl: null, layers, lastRun: null, restorable: null,
});

describe("stack view (workstream K)", () => {
  it("offers draft only above the bottom, and branch for drafts", () => {
    const s = stack([layer(1, "merged"), layer(2, "ready"), layer(3, "branch_only"), layer(4, "draft")]);
    expect(s.layers.map((l) => layerActions(s, l))).toEqual([[], [], ["toDraft"], ["toBranch"]]);
    const b = stack([layer(1, "branch_only"), layer(2, "branch_only")]);
    expect(layerActions(b, b.layers[0]!)).toEqual([]);
  });

  it("writes notices and the latest run in both languages", () => {
    for (const S of Object.values(STRINGS)) {
      expect(stackNoticeText({ reason: "conflict", stackId: 1, stackName: "pay", branch: "b2", files: ["a.ts", "b.ts"] }, S)).toContain("a.ts, b.ts");
      expect(stackNoticeText({ reason: "behind", stackId: 1, stackName: "pay", branch: "b1", commits: 25, days: 4 }, S)).toContain("25");
      expect(stackNoticeText({ reason: "draft_stale", stackId: 1, stackName: "pay", branch: "b3", days: 15 }, S)).toContain("b3");
      expect(stackNoticeText({ reason: "stuck", stackId: 1, stackName: "pay", branch: "b1", detail: "gate held" }, S)).toContain("gate held");
      const rewritten = stackNoticeText({ reason: "rewritten", stackId: 1, stackName: "pay", branch: "b1", branches: ["b1", "b2"] }, S);
      expect(rewritten).toContain("b1, b2");
      expect(rewritten).toMatch(/没编译|nothing was built/);
      for (const why of ["ready_pr", "handoff"] as const) {
        expect(stackNoticeText({ reason: "confirm", stackId: 1, stackName: "pay", branch: "b1", detail: why }, S)).toMatch(/不编译|doesn't build/);
        expect(S.sk.confirmLine(why, "b1")).toMatch(/不编译|doesn't build/);
      }
      const lines = lastRunLines({ id: 1, trigger: "bottom_merged", mode: "update_refs", outcome: "conflict", reason: null, hasBackup: true, conflict: { branch: "b2", files: ["x"] }, unpushed: ["b3"], confirm: null, startedAt: 0, finishedAt: 1 }, S, 0);
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("b2");
      expect(lines[2]).toContain("b3");
    }
    expect(lastRunLines(null, STRINGS.zh, 0)).toEqual([]);
  });

  it("only promises what really happens: a force push when pushing is on, a verify request when one was delivered (BTL-278)", () => {
    for (const S of Object.values(STRINGS)) {
      for (const why of ["ready_pr", "handoff"] as const) {
        expect(S.sk.confirmLine(why, "b1", true)).toMatch(/强推|force-push/);
        expect(S.sk.confirmLine(why, "b1", false)).not.toMatch(/再强推|then force-push/);
        expect(S.sk.confirmLine(why, "b1", false)).toMatch(/不推|nothing is pushed|doesn't push/i);
      }
      const confirm = (push: boolean) => lastRunLines({ id: 1, trigger: "main_updated", mode: "update_refs", outcome: "needs_confirm", reason: null, hasBackup: false, conflict: null, unpushed: [], confirm: { why: "ready_pr", branches: ["b1"], push }, startedAt: 0, finishedAt: 1 }, S, 0).join("\n");
      expect(confirm(false)).toContain(S.sk.confirmLine("ready_pr", "b1", false));
      expect(confirm(true)).toContain(S.sk.confirmLine("ready_pr", "b1", true));
      const n = (asked: string[]) => stackNoticeText({ reason: "rewritten", stackId: 1, stackName: "pay", branch: "b1", branches: ["b1", "b2"], asked }, S);
      const askedRe = (b: string) => new RegExp(`已经请 ${b} 的 session|The session of ${b} was asked`);
      const restRe = (b: string) => new RegExp(`${b} 没有 session 收到|No session got a request to check ${b}:`);
      // 都送到了：不说「没有 session 收到」；一个都没送到：不说「已经请」
      expect(n(["b1", "b2"])).toMatch(askedRe("b1, b2"));
      expect(n(["b1", "b2"])).not.toMatch(/没有 session 收到|No session got/);
      expect(n([])).not.toMatch(/已经请|was asked/);
      expect(n([])).toMatch(restRe("b1, b2"));
      expect(n(["b1"])).toMatch(askedRe("b1"));
      expect(n(["b1"])).toMatch(restRe("b2"));
      expect(stackNoticeText({ reason: "prs_unreadable", stackId: 1, stackName: "pay", branch: "b1", host: "git.corp.io" }, S)).toContain("gh auth login --hostname git.corp.io");
      expect(stackNoticeText({ reason: "prs_unreadable", stackId: 1, stackName: "pay", branch: "b1", host: null }, S)).toContain("gh auth login");
      expect(stackNoticeText({ reason: "markers", stackId: 1, stackName: "pay", branch: "b1", files: ["x.ts"] }, S)).toContain("x.ts");
      expect(stackNoticeText({ reason: "markers", stackId: 1, stackName: "pay", branch: "b1", files: [] }, S)).toContain(S.sk.rebaseNow);
    }
  });

  it("says why a run waits for a confirm, and who turned autoRebase on or off (BTL-278)", () => {
    for (const S of Object.values(STRINGS)) {
      const ready = stackNoticeText({ reason: "confirm", stackId: 1, stackName: "pay", branch: "b1", branches: ["b1", "b2"], detail: "ready_pr", prNumber: 7 }, S);
      expect(ready).toContain("pay");
      expect(ready).toContain("b1, b2");
      expect(ready).toContain(S.sk.rebaseNow);
      const handed = stackNoticeText({ reason: "confirm", stackId: 1, stackName: "pay", branch: "b2", branches: ["b2"], detail: "handoff" }, S);
      expect(handed).not.toBe(ready.replace("b1, b2", "b2"));
      const lines = lastRunLines({ id: 1, trigger: "main_updated", mode: "update_refs", outcome: "needs_confirm", reason: "ready_pr: b1", hasBackup: false, conflict: null, unpushed: [], confirm: { why: "ready_pr", branches: ["b1"] }, startedAt: 0, finishedAt: 1 }, S, 0);
      expect(lines[0]).toContain(S.sk.outcome.needs_confirm);
      expect(lines[1]).toContain("b1");
      const s = stack([layer(1, "ready")]);
      expect(stackAutoRebaseNote(s, S)).toBeNull();
      expect(stackAutoRebaseNote({ ...s, autoRebase: false }, S)).toBe(S.sk.autoRebaseOff);
      expect(stackAutoRebaseNote({ ...s, autoRebaseBy: "epic" }, S)).toBe(S.sk.autoRebaseEpicOn);
      expect(stackAutoRebaseNote({ ...s, autoRebase: false, autoRebaseBy: "epic" }, S)).toBe(S.sk.autoRebaseEpicOff);
      expect(stackAutoRebaseNote({ ...s, autoRebase: false, autoRebaseBy: "explicit_off" }, S)).toBe(S.sk.autoRebaseExplicitOff);
      expect(stackEpicLines({ on: [], ignored: [] }, S)).toEqual([]);
      const epic = stackEpicLines({ on: ["pay"], ignored: ["ship"] }, S);
      expect(epic).toHaveLength(2);
      expect(epic[0]).toContain("pay");
      expect(epic[1]).toContain("ship");
    }
    expect(STRINGS.zh.sk.autoRebaseEpicOn).toContain("因为 epic 是半自动，已开着");
  });

  it("parses policy input by key kind", () => {
    expect(stackKeyKind("autoRebase")).toEqual({ kind: "bool" });
    expect(stackKeyKind("mergeMethod")).toMatchObject({ kind: "enum" });
    expect(stackKeyKind("behindDays")).toEqual({ kind: "int", min: 1, max: 365 });
    expect(stackKeyKind("draftLabel")).toEqual({ kind: "text" });
    expect(parseStackInput("autoRebase", "true")).toEqual({ ok: true, value: true });
    expect(parseStackInput("behindDays", " 7 ")).toEqual({ ok: true, value: 7 });
    expect(parseStackInput("behindDays", "0")).toEqual({ ok: false, code: "bad_int" });
    expect(parseStackInput("draftLabel", "a,b")).toEqual({ ok: false, code: "bad_label" });
    expect(parseStackInput("overview", "")).toEqual({ ok: true, value: null });
  });

  it("builds the whole layer from overrides and the draft", () => {
    const view: StackPolicyView = {
      scope: { kind: "global" },
      keys: [
        { key: "autoRebase", effective: true, origin: { kind: "global" }, set: true, override: true },
        { key: "behindDays", effective: 3, origin: { kind: "default" }, set: false, override: null },
      ],
    };
    expect(stackOverridesFromDraft(view, {})).toEqual({ ok: true, overrides: { autoRebase: true }, changed: false });
    expect(stackOverridesFromDraft(view, { autoRebase: "", behindDays: "5" })).toEqual({ ok: true, overrides: { behindDays: 5 }, changed: true });
    expect(stackOverridesFromDraft(view, { behindDays: "x" })).toEqual({ ok: false, key: "behindDays", code: "bad_int" });
    expect(stackShown({ key: "mergeMethod", effective: "auto" }, STRINGS.zh)).toBe(STRINGS.zh.sk.option.auto);
  });
});
