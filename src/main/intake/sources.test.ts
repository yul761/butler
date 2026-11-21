import { describe, expect, it, vi } from "vitest";
import { fileSource, mapRepo, normalizeIncoming, normalizeList, parseRepoMap, trackerSource } from "./sources";

const read = (text: string) => async () => text;

describe("normalizeIncoming", () => {
  it("keeps the known fields, trims, caps and drops bad ones", () => {
    const t = normalizeIncoming({
      key: " PROJ-1 ", summary: "  Fix\nthe  thing ", description: "body\u0007", labels: ["a", "a", 3, "b"], storyPoints: -1, url: "javascript:x",
      subtasks: [{ key: "PROJ-2", title: "s" }, { key: "", title: "x" }, "bad"], repo: "/r", extra: 1,
    });
    expect(t).toEqual({
      key: "PROJ-1", title: "Fix the thing", description: "body", type: null, labels: ["a", "b"], priority: null, url: null, storyPoints: null,
      components: [], subtasks: [{ key: "PROJ-2", title: "s" }], repo: "/r",
    });
    expect(normalizeIncoming({ key: "X-1" })).toBeNull();
    expect(normalizeIncoming("nope")).toBeNull();
    expect(normalizeIncoming({ key: "X-1", title: "t", url: "https://tracker.example/X-1", storyPoints: 3 })).toMatchObject({ url: "https://tracker.example/X-1", storyPoints: 3 });
  });

  it("takes the parent epic as { key, title } or a bare key, and leaves it out when there is none (BTL-246 §7)", () => {
    expect(normalizeIncoming({ key: "A-1", title: "t", epic: { key: " SHOP-9 ", title: " Checkout\nrevamp " } })).toMatchObject({ epic: { key: "SHOP-9", title: "Checkout revamp" } });
    expect(normalizeIncoming({ key: "A-1", title: "t", epic: { key: "SHOP-9", summary: "Checkout" } })).toMatchObject({ epic: { key: "SHOP-9", title: "Checkout" } });
    expect(normalizeIncoming({ key: "A-1", title: "t", epic: "SHOP-9" })).toMatchObject({ epic: { key: "SHOP-9", title: null } });
    // 和 ticket 的 key 一样按大写去重：一次给 shop-9、一次给 SHOP-9 也是同一个 epic。
    expect(normalizeIncoming({ key: "A-1", title: "t", epic: " shop-9" })).toMatchObject({ epic: { key: "SHOP-9" } });
    // 没有 epic、给错了：不带这个字段（以前存的 payload 和这一样，内容哈希不变）。
    for (const epic of [undefined, null, "", { title: "x" }, 7, ["SHOP-9"]]) expect(normalizeIncoming({ key: "A-1", title: "t", epic })).not.toHaveProperty("epic");
  });

  it("dedupes by key", () => {
    expect(normalizeList([{ key: "A-1", title: "x" }, { key: "A-1", title: "y" }, { key: "A-2", title: "z" }]).map((t) => t.title)).toEqual(["x", "z"]);
  });
});

describe("fileSource", () => {
  it("reads an object with tickets or a bare array", async () => {
    expect(await fileSource("/f", read(JSON.stringify({ tickets: [{ key: "A-1", title: "x" }] }))).fetch()).toMatchObject({ ok: true, tickets: [{ key: "A-1" }] });
    expect(await fileSource("/f", read(JSON.stringify([{ key: "A-1", title: "x" }]))).fetch()).toMatchObject({ ok: true, tickets: [{ key: "A-1" }] });
  });

  it("reports a bad or missing file", async () => {
    expect(await fileSource("/f", read("{")).fetch()).toEqual({ ok: false, message: "bad json" });
    expect(await fileSource("/f", read("{}")).fetch()).toEqual({ ok: false, message: "no tickets array" });
    const missing = fileSource("/f", async () => {
      throw Object.assign(new Error("x"), { code: "ENOENT" });
    });
    expect(await missing.fetch()).toEqual({ ok: false, message: "read: ENOENT" });
  });
});

describe("repo map", () => {
  const { rules, errors } = parseRepoMap(
    ["# comment", "label:frontend => /work/web", "PROJ => /work/app", "component:Docs => C:\\work\\docs", "OPS- => relative/path", "bad line", "* => /work/misc"].join("\r\n"),
  );

  it("parses rules and reports bad lines", () => {
    expect(rules.map((r) => r.kind)).toEqual(["label", "prefix", "component", "any"]);
    expect(errors).toEqual([5, 6]);
  });

  it("first match wins; an explicit absolute repo wins over the map", () => {
    const t = { key: "PROJ-1", title: "x", description: "", type: null, labels: [] as string[], priority: null, url: null, storyPoints: null, components: [] as string[], subtasks: [], repo: null as string | null };
    expect(mapRepo(t, rules)).toBe("/work/app");
    expect(mapRepo({ ...t, labels: ["Frontend"] }, rules)).toBe("/work/web");
    expect(mapRepo({ ...t, key: "OTHER-1", components: ["docs"] }, rules)).toBe("C:\\work\\docs");
    expect(mapRepo({ ...t, key: "OTHER-1" }, rules)).toBe("/work/misc");
    expect(mapRepo({ ...t, key: "OTHER-1" }, rules.slice(0, 3))).toBeNull();
    expect(mapRepo({ ...t, repo: "/explicit" }, rules)).toBe("/explicit");
    expect(mapRepo({ ...t, repo: "relative" }, rules)).toBe("/work/app");
  });
});

describe("trackerSource", () => {
  it("does not run without a directory or a query", async () => {
    const exec = vi.fn();
    expect(await trackerSource(exec as never, () => null, "mine", () => [], () => "en").fetch()).toEqual({ ok: false, message: "no tracker dir" });
    expect(await trackerSource(exec as never, () => "/work/web", "  ", () => [], () => "en").fetch()).toEqual({ ok: false, message: "no tracker query" });
    expect(exec).not.toHaveBeenCalled();
  });
});
