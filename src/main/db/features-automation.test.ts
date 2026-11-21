import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { FeaturesRepo } from "./features-repo";

describe("features.automation_level (BTL-247)", () => {
  it("starts as null (follow the global level) and stores manual or semi", () => {
    const repo = new FeaturesRepo(memDb());
    const id = repo.insert({ name: "checkout", workspaceDir: "/w/checkout", createdAt: 1 });
    expect(repo.get(id)?.automationLevel).toBeNull();
    expect(repo.automationLevel(id)).toBeNull();
    repo.setAutomationLevel(id, "semi");
    expect(repo.get(id)?.automationLevel).toBe("semi");
    expect(repo.automationLevel(id)).toBe("semi");
    repo.setAutomationLevel(id, null);
    expect(repo.automationLevel(id)).toBeNull();
    expect(repo.automationLevel(999)).toBeNull();
  });

  it("refuses other values at the database level", () => {
    const db = memDb();
    const id = new FeaturesRepo(db).insert({ name: "x", workspaceDir: "/w/x", createdAt: 1 });
    expect(() => db.prepare(`UPDATE features SET automation_level = 'full' WHERE id = ?`).run(id)).toThrow();
  });
});
