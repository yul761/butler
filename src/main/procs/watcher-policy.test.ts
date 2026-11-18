import { afterEach, describe, expect, it } from "vitest";
import { sessionGuide } from "../claude/session-guide";
import { endWatchersOnHibernate, setWatcherPolicy, watcherGuideLines, watcherPolicy } from "./watcher-policy";

afterEach(() => setWatcherPolicy(null));

describe("watcher policy hook (WS-M I)", () => {
  it("has no rule by default, so the setting decides", () => {
    expect(watcherPolicy("/r/a")).toBeNull();
    expect(endWatchersOnHibernate(["/r/a"], true)).toBe(true);
    expect(endWatchersOnHibernate(["/r/a"], false)).toBe(false);
    expect(watcherGuideLines("zh", ["/r/a"])).toEqual([]);
  });

  it("follows a registered repo profile, and treats a throwing one as no rule", () => {
    setWatcherPolicy((p) => (p === "/r/end" ? "end" : p === "/r/keep" ? "keep" : null));
    expect(endWatchersOnHibernate(["/r/keep"], true)).toBe(false);
    expect(endWatchersOnHibernate(["/r/keep", "/r/end"], false)).toBe(true);
    expect(endWatchersOnHibernate(["/r/keep", "/r/x"], false)).toBe(false);
    expect(watcherGuideLines("en", ["/r/end", "/r/end", "/r/keep"])).toHaveLength(1);
    setWatcherPolicy(() => {
      throw new Error("bad profile");
    });
    expect(watcherPolicy("/r/end")).toBeNull();
  });

  it("puts the line into a ticket session's guide", () => {
    setWatcherPolicy(() => "end");
    const extra = watcherGuideLines("zh", ["/r/a"]);
    expect(sessionGuide("zh", "ticket", [], { extra })).toContain("不要让 watch 模式的命令");
    expect(sessionGuide("zh", "ticket")).not.toContain("不要让 watch 模式的命令");
  });
});
