import { describe, expect, it } from "vitest";
import { PATROL_TURN_MAX_MS, PatrolTurns, sentByPatrol } from "./patrol-turns";

describe("PatrolTurns (BTL-279 review suggestion 3)", () => {
  it("is active from the patrol delivery until that head stops, per head", () => {
    const t = new PatrolTurns(() => 0);
    expect(t.active("bt")).toBe(false);
    t.delivered("bt", 0);
    expect(t.active("bt")).toBe(true);
    expect(t.active("other")).toBe(false);
    t.stopped("other");
    expect(t.active("bt")).toBe(true);
    t.stopped("bt");
    expect(t.active("bt")).toBe(false);
  });

  it("ends on its own after the max turn length when the Stop got lost", () => {
    let now = 0;
    const t = new PatrolTurns(() => now);
    t.delivered("bt", now);
    now = PATROL_TURN_MAX_MS - 1;
    expect(t.active("bt")).toBe(true);
    now = PATROL_TURN_MAX_MS;
    expect(t.active("bt")).toBe(false);
    // 过期后清掉：时间倒回来也不再算。
    now = 0;
    expect(t.active("bt")).toBe(false);
  });

  it("a new patrol delivery restarts the turn", () => {
    let now = 0;
    const t = new PatrolTurns(() => now);
    t.delivered("bt", now);
    now = PATROL_TURN_MAX_MS - 10;
    t.delivered("bt", now);
    now = PATROL_TURN_MAX_MS + 10;
    expect(t.active("bt")).toBe(true);
  });

  it("a patrol delivery recorded only after that turn stopped (its hook event got lost, the Stop sweep found it) opens no new patrol turn (third review)", () => {
    let now = 1000;
    const t = new PatrolTurns(() => now);
    // hook 在 1000 拿走了巡检消息，记上它的那个事件丢了；那一轮在 5000 停下，Stop 时的清扫才记上。
    now = 5000;
    t.stopped("bt");
    t.delivered("bt", 1000);
    expect(t.active("bt")).toBe(false);
    // 停下时那一刻记上的也不算（同一毫秒）。
    t.delivered("bt", 5000);
    expect(t.active("bt")).toBe(false);
    // 下一轮真的送到了巡检消息：照常算。
    now = 6000;
    t.delivered("bt", 6000);
    expect(t.active("bt")).toBe(true);
    // 别的 head 停下不影响。
    expect(new PatrolTurns(() => 0).active("bt")).toBe(false);
  });

  it("the turn length counts from the delivery, not from when it got recorded", () => {
    let now = 0;
    const t = new PatrolTurns(() => now);
    now = 100;
    t.delivered("bt", 0);
    now = PATROL_TURN_MAX_MS;
    expect(t.active("bt")).toBe(false);
  });

  it("sentByPatrol reads only meta.auto === patrol", () => {
    expect(sentByPatrol({ auto: "patrol" })).toBe(true);
    expect(sentByPatrol({ auto: "patrol", answers: 1 })).toBe(true);
    for (const x of [null, undefined, "patrol", 3, {}, { auto: "other" }, { answers: 1 }]) expect(sentByPatrol(x)).toBe(false);
  });
});
