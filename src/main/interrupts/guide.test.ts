import { describe, expect, it } from "vitest";
import { interruptGuideLines } from "./guide";

describe("interruptGuideLines", () => {
  it("writes nothing while both switches are off, and nothing for epic, butler or lessons sessions", () => {
    expect(interruptGuideLines("zh", "ticket", { choiceRule: false, selfServe: false })).toEqual([]);
    for (const kind of ["epic", "butler", "lessons"] as const) expect(interruptGuideLines("en", kind, { choiceRule: true, selfServe: true })).toEqual([]);
  });

  it("tells ticket sessions and coordinators to pick the recommended option and record it, with the exceptions", () => {
    for (const kind of ["ticket", "coordinator"] as const) {
      const [en] = interruptGuideLines("en", kind, { choiceRule: true, selfServe: false });
      expect(en).toContain('report (kind: "choice")');
      expect(en).toContain("irreversible");
      expect(interruptGuideLines("zh", kind, { choiceRule: true, selfServe: false })[0]).toContain("recommended");
    }
  });

  it("lists where to look before asking; only ticket sessions are told to ask their coordinator", () => {
    expect(interruptGuideLines("en", "ticket", { choiceRule: false, selfServe: true })[0]).toContain("blocked");
    expect(interruptGuideLines("en", "coordinator", { choiceRule: false, selfServe: true })[0]).not.toContain("blocked");
    expect(interruptGuideLines("zh", "ticket", { choiceRule: true, selfServe: true })).toHaveLength(2);
  });
});
