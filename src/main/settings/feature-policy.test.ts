import { describe, expect, it } from "vitest";
import type { Db } from "../db/database";
import { memDb } from "../test-utils";
import { readFeaturePolicy, readGovernedLayers } from "./feature-policy";

type Table = "loop_policies" | "stack_policies" | "intake_policies";

function layer(db: Db, table: Table, scope: { kind: "global" } | { kind: "product"; id: number } | { kind: "repo"; slug: string }, overrides: unknown): void {
  db.prepare(`INSERT INTO ${table} (scope_kind, product_id, repo_slug, overrides, updated_at) VALUES (?, ?, ?, ?, 1)`).run(
    scope.kind,
    scope.kind === "product" ? scope.id : null,
    scope.kind === "repo" ? scope.slug : null,
    typeof overrides === "string" ? overrides : JSON.stringify(overrides),
  );
}

const noName = (): string | null => null;

describe("readFeaturePolicy", () => {
  it("reads the global value from the global layer and falls back to the default", () => {
    const db = memDb();
    let s = readFeaturePolicy(db, noName);
    expect(s.globals).toEqual({ "loop:ci.enabled": false, "loop:comments.enabled": false, "stacks:autoRebase": false, "intake:enabled": false });
    expect(s.overrides).toEqual([]);
    layer(db, "loop_policies", { kind: "global" }, { "ci.enabled": true });
    layer(db, "stack_policies", { kind: "global" }, { autoRebase: true });
    s = readFeaturePolicy(db, noName);
    expect(s.globals["loop:ci.enabled"]).toBe(true);
    expect(s.globals["loop:comments.enabled"]).toBe(false);
    expect(s.globals["stacks:autoRebase"]).toBe(true);
    expect(s.overrides).toEqual([]);
  });

  it("lists non-global layers that set a feature key, with labels", () => {
    const db = memDb();
    layer(db, "loop_policies", { kind: "repo", slug: "acme/web" }, { "comments.enabled": true, "ci.maxReruns": 3 });
    layer(db, "intake_policies", { kind: "product", id: 4 }, { enabled: true, maxSize: "s" });
    layer(db, "stack_policies", { kind: "product", id: 9 }, { autoRebase: false });
    const s = readFeaturePolicy(db, (id) => (id === 4 ? "Shop" : null));
    expect(s.overrides).toEqual(
      expect.arrayContaining([
        { family: "loop", key: "comments.enabled", scope: { kind: "repo", slug: "acme/web" }, label: "acme/web", value: true },
        { family: "intake", key: "enabled", scope: { kind: "product", productId: 4 }, label: "Shop", value: true },
        { family: "stacks", key: "autoRebase", scope: { kind: "product", productId: 9 }, label: "#9", value: false },
      ]),
    );
    expect(s.overrides).toHaveLength(3);
  });

  it("drops garbage in stored overrides instead of throwing", () => {
    const db = memDb();
    layer(db, "loop_policies", { kind: "repo", slug: "a/bad" }, "{not json");
    layer(db, "loop_policies", { kind: "repo", slug: "a/odd" }, { "ci.enabled": "yes", nonsense: true });
    layer(db, "stack_policies", { kind: "global" }, "[]");
    const s = readFeaturePolicy(db, noName);
    expect(s.overrides).toEqual([]);
    expect(s.globals["stacks:autoRebase"]).toBe(false);
  });

  it("reads 500 repo layers with a single pass", () => {
    const db = memDb();
    for (let i = 0; i < 500; i++) layer(db, "loop_policies", { kind: "repo", slug: `o/r${i}` }, { "ci.enabled": i % 2 === 0 });
    const prepared: string[] = [];
    const counting = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => {
          prepared.push(sql);
          return target.prepare(sql);
        };
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const s = readFeaturePolicy(counting, noName);
    expect(s.overrides).toHaveLength(500);
    expect(prepared).toHaveLength(3);
    for (const t of ["loop_policies", "stack_policies", "intake_policies"]) expect(prepared.filter((q) => q.includes(t))).toHaveLength(1);
  });
});

describe("readGovernedLayers", () => {
  it("lists every layer that sets a governed key, with only the governed keys", () => {
    const db = memDb();
    layer(db, "loop_policies", { kind: "global" }, { "ci.maxReruns": 1, "ci.flakyTests": ["a"] });
    layer(db, "loop_policies", { kind: "repo", slug: "acme/web" }, { "ci.useModel": false });
    layer(db, "intake_policies", { kind: "product", id: 4 }, { autoStart: false });
    expect(readGovernedLayers(db, (id) => (id === 4 ? "Shop" : null))).toEqual([
      { family: "loop", scope: "global", label: "", values: { "ci.maxReruns": 1 } },
      { family: "intake", scope: "product", label: "Shop", values: { autoStart: false } },
    ]);
  });
});
