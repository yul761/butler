import { describe, expect, it } from "vitest";
import { parseControlRequest } from "./control";

describe("workflow control requests (BTL-273)", () => {
  const feature = { v: 1, featureId: 4, from: "c" };
  const shipherd = { v: 1, shipherd: true, from: "g" };
  const ticket = { v: 1, ticketKey: "A-1", from: "s" };

  it("parses the coordinator tools in both coordinator scopes", () => {
    for (const base of [feature, shipherd]) {
      expect(parseControlRequest({ ...base, op: "list_workflow_presets" })).toEqual({ ...base, op: "list_workflow_presets" });
      expect(parseControlRequest({ ...base, op: "get_workflow" })).toEqual({ ...base, op: "get_workflow" });
      expect(parseControlRequest({ ...base, op: "get_workflow", ticket: " A-1 " })).toEqual({ ...base, op: "get_workflow", ticket: "A-1" });
      expect(parseControlRequest({ ...base, op: "set_workflow", scope: "repo:o/a", steps: ["implement"], notes: "n" })).toEqual({ ...base, op: "set_workflow", scope: "repo:o/a", steps: ["implement"], notes: "n" });
      expect(parseControlRequest({ ...base, op: "set_workflow", steps: null })).toEqual({ ...base, op: "set_workflow", steps: null });
    }
  });

  it("refuses bad coordinator requests instead of truncating", () => {
    for (const bad of [
      { op: "set_workflow" },
      { op: "set_workflow", steps: [] },
      { op: "set_workflow", steps: "implement" },
      { op: "set_workflow", steps: ["implement"], notes: "x".repeat(4001) },
      { op: "set_workflow", scope: "moon:x", steps: null },
      { op: "get_workflow", scope: "global", ticket: "A-1" },
    ]) {
      expect(parseControlRequest({ ...feature, ...bad }), JSON.stringify(bad).slice(0, 60)).toBeNull();
    }
    // ticket session 不能用总控的工具
    expect(parseControlRequest({ ...ticket, op: "set_workflow", steps: null })).toBeNull();
  });

  it("parses workflow_step_done only for a ticket session", () => {
    expect(parseControlRequest({ ...ticket, op: "workflow_step_done", step: "implement", note: "  " })).toEqual({ ...ticket, op: "workflow_step_done", step: "implement" });
    expect(parseControlRequest({ ...ticket, op: "workflow_step_done", step: "fly" })).toBeNull();
    expect(parseControlRequest({ ...ticket, op: "workflow_step_done", step: "implement", note: "x".repeat(501) })).toBeNull();
    expect(parseControlRequest({ ...feature, op: "workflow_step_done", step: "implement" })).toBeNull();
  });
});
