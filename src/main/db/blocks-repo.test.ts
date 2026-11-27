import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { BlocksRepo } from "./blocks-repo";
import { FeaturesRepo } from "./features-repo";

describe("BlocksRepo.listMany (BTL-275)", () => {
  it("reads several epics' features in one query, each in the same order as list()", () => {
    const db = memDb();
    const features = new FeaturesRepo(db);
    const [a, b, empty] = ["a", "b", "c"].map((name) => features.insert({ name, workspaceDir: `/w/${name}`, createdAt: 1 }));
    const blocks = new BlocksRepo(db);
    const a2 = blocks.insert({ featureId: a, name: "a2", description: null, createdAt: 1 });
    blocks.insert({ featureId: a, name: "a1", description: null, createdAt: 2, before: a2 });
    blocks.insert({ featureId: b, name: "b1", description: "d", createdAt: 3 });
    const many = blocks.listMany([a, b, empty]);
    expect(many.get(a)).toEqual(blocks.list(a));
    expect(many.get(a)!.map((x) => x.name)).toEqual(["a1", "a2"]);
    expect(many.get(b)).toEqual(blocks.list(b));
    expect(many.get(empty)).toBeUndefined();
    expect(blocks.listMany([]).size).toBe(0);
  });
});
