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

  it("only a patrol message typed in (via input) opens a patrol turn; one a hook slipped into someone else's turn does not (fourth review, controller's call)", () => {
    let now = 1000;
    const t = new PatrolTurns(() => now);
    // 用户叫全局总控做事，那一轮中间 hook 把巡检消息带了进去：这一轮不是巡检。
    t.messageDelivered("bt", { kind: "patrol", via: "hook", deliveredAt: 1000 });
    expect(t.active("bt")).toBe(false);
    for (const m of [{ kind: "instruction", via: "input" as const, deliveredAt: 1000 }, { kind: "shipherd", via: "input" as const, deliveredAt: 1000 }, { kind: "patrol", via: null, deliveredAt: 1000 }]) {
      t.messageDelivered("bt", m);
      expect(t.active("bt"), m.kind).toBe(false);
    }
    // 停着的时候直接输入进去、自己开了一轮：算。记账晚了一点（now 已经过了粘贴的时刻）。
    now = 5000;
    t.messageDelivered("bt", { kind: "patrol", via: "input", deliveredAt: 1000 });
    expect(t.active("bt")).toBe(true);
    // 从粘贴的时刻算起，不从记账的时刻；没记时间就按现在。
    now = 1000 + PATROL_TURN_MAX_MS;
    expect(t.active("bt")).toBe(false);
    t.messageDelivered("other", { kind: "patrol", via: "input", deliveredAt: null });
    now += PATROL_TURN_MAX_MS - 1;
    expect(t.active("other")).toBe(true);
  });

  it("the user's own words delivered into the patrol turn end it, through the hook or typed in; other kinds do not (sixth review, controller's call)", () => {
    for (const via of ["hook", "input"] as const) {
      let now = 1000;
      const t = new PatrolTurns(() => now);
      t.messageDelivered("bt", { kind: "patrol", via: "input", deliveredAt: now });
      t.messageDelivered("other", { kind: "patrol", via: "input", deliveredAt: now });
      now += 10;
      for (const kind of ["shipherd", "reply", "report", "instruction"]) t.messageDelivered("bt", { kind, via, deliveredAt: now });
      expect(t.active("bt")).toBe(true);
      t.messageDelivered("bt", { kind: "user", via, deliveredAt: now });
      expect(t.active("bt")).toBe(false);
      // 只结束那一个 head 的。
      expect(t.active("other")).toBe(true);
      // 用户说完之后再来一条直接输入的巡检（下一次停下以后）照样开一轮。
      now += 10;
      t.messageDelivered("bt", { kind: "patrol", via: "input", deliveredAt: now });
      expect(t.active("bt")).toBe(true);
    }
  });

  it("the user's words arriving through the hook while the typed-in patrol is still being delivered: the patrol's late callback opens no patrol turn (seventh review suggestion 4)", () => {
    let now = 1000;
    const t = new PatrolTurns(() => now);
    // 巡检在 1000 粘贴进去，deliver 还没返回；1005 用户的话从 hook 进了这一轮。
    now = 1005;
    t.messageDelivered("bt", { kind: "user", via: "hook", deliveredAt: 1005 });
    // deliver 返回，巡检的回调带着粘贴时刻 1000 晚到：不再设巡检标记。
    now = 1010;
    t.messageDelivered("bt", { kind: "patrol", via: "input", deliveredAt: 1000 });
    expect(t.active("bt")).toBe(false);
    // 用户的话之后才粘贴的巡检（下一轮）照样开。
    t.messageDelivered("bt", { kind: "patrol", via: "input", deliveredAt: 1010 });
    expect(t.active("bt")).toBe(true);
    // 一条更早的用户的话晚到，不把结束时间往回拨：1000 粘贴的那条还是不算。
    t.messageDelivered("bt", { kind: "user", via: "hook", deliveredAt: 900 });
    t.messageDelivered("bt", { kind: "patrol", via: "input", deliveredAt: 1000 });
    expect(t.active("bt")).toBe(false);
  });

  it("a delivery time later than now counts from now", () => {
    let now = 0;
    const t = new PatrolTurns(() => now);
    t.delivered("bt", 1000);
    now = PATROL_TURN_MAX_MS;
    expect(t.active("bt")).toBe(false);
  });

  it("forget drops both the open turn and the last stop of that head only (fourth review: nothing stays around after the terminal exits)", () => {
    const t = new PatrolTurns(() => 100);
    t.delivered("a", 100);
    t.stopped("b");
    t.delivered("c", 100);
    t.stopped("c");
    expect(t.size).toBe(3);
    t.forget("a");
    expect(t.active("a")).toBe(false);
    t.forget("c");
    expect(t.size).toBe(1);
    // b 的停下记录还在：比它早的照样不算。
    t.delivered("b", 100);
    expect(t.active("b")).toBe(false);
    // c 忘掉了停下的时间：重新打开后同一刻送到的又算了。
    t.delivered("c", 100);
    expect(t.active("c")).toBe(true);
    t.forget("b");
    t.forget("c");
    expect(t.size).toBe(0);
  });

  it("sentByPatrol reads only meta.auto === patrol", () => {
    expect(sentByPatrol({ auto: "patrol" })).toBe(true);
    expect(sentByPatrol({ auto: "patrol", answers: 1 })).toBe(true);
    for (const x of [null, undefined, "patrol", 3, {}, { auto: "other" }, { answers: 1 }]) expect(sentByPatrol(x)).toBe(false);
  });
});
