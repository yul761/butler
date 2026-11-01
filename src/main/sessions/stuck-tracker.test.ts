import { describe, expect, it } from "vitest";
import { CPU_CHANGE_MS, STUCK_CHECK_MS, STUCK_REJUDGE_MS, StuckTracker, type StuckSample } from "./stuck-tracker";

const S = (o: Partial<StuckSample> = {}): StuckSample => ({ transcriptSize: 100, outputSize: 50, childCpuMs: 1000, eligible: true, ...o });
const verdict = (stuck: boolean) => ({ stuck, reason: "r", action: "a" });

describe("StuckTracker", () => {
  it("两次检查都没变化时第二次返回 true", () => {
    const t = new StuckTracker();
    expect(t.observe("a", S(), 0)).toBe(false);
    expect(t.observe("a", S(), STUCK_CHECK_MS)).toBe(true);
  });

  it("任何一项有变化都会让计数清零", () => {
    for (const change of [{ transcriptSize: 101 }, { outputSize: 51 }, { childCpuMs: 1000 + CPU_CHANGE_MS }]) {
      const t = new StuckTracker();
      t.observe("a", S(), 0);
      expect(t.observe("a", S(change), STUCK_CHECK_MS)).toBe(false);
      expect(t.observe("a", S(change), STUCK_CHECK_MS * 2)).toBe(false);
      expect(t.observe("a", S(change), STUCK_CHECK_MS * 3)).toBe(true);
    }
  });

  it("childCpuMs 变化小于 2000 不算变化；null 时只看另外两项", () => {
    const t = new StuckTracker();
    t.observe("a", S(), 0);
    expect(t.observe("a", S({ childCpuMs: 1000 + CPU_CHANGE_MS - 1 }), STUCK_CHECK_MS)).toBe(true);
    const n = new StuckTracker();
    n.observe("a", S({ childCpuMs: null }), 0);
    expect(n.observe("a", S({ childCpuMs: null }), STUCK_CHECK_MS)).toBe(true);
    const m = new StuckTracker();
    m.observe("a", S({ childCpuMs: 5000 }), 0);
    expect(m.observe("a", S({ childCpuMs: null }), STUCK_CHECK_MS)).toBe(true);
  });

  it("eligible 为 false 时计数清零且返回 false", () => {
    const t = new StuckTracker();
    t.observe("a", S(), 0);
    expect(t.observe("a", S({ eligible: false }), STUCK_CHECK_MS)).toBe(false);
    expect(t.observe("a", S(), STUCK_CHECK_MS * 2)).toBe(false);
    expect(t.observe("a", S(), STUCK_CHECK_MS * 3)).toBe(true);
  });

  it("两次检查间隔超过 STUCK_CHECK_MS * 2 时计数清零", () => {
    const t = new StuckTracker();
    t.observe("a", S({ transcriptSize: 1 }), 0);
    t.observe("a", S({ transcriptSize: 2 }), STUCK_CHECK_MS); // 变化，计数 0
    expect(t.observe("a", S({ transcriptSize: 2 }), STUCK_CHECK_MS + STUCK_CHECK_MS * 2 + 1)).toBe(false);
    expect(t.observe("a", S({ transcriptSize: 2 }), STUCK_CHECK_MS * 4)).toBe(true);
  });

  it("不同 id 互不影响，forget 后重新开始", () => {
    const t = new StuckTracker();
    t.observe("a", S(), 0);
    expect(t.observe("b", S(), STUCK_CHECK_MS)).toBe(false);
    t.forget("a");
    expect(t.observe("a", S(), STUCK_CHECK_MS)).toBe(false);
  });

  it("judged(stuck:false) 后 10 分钟内 observe 不返回 true", () => {
    const t = new StuckTracker();
    t.observe("a", S(), 0);
    expect(t.observe("a", S(), STUCK_CHECK_MS)).toBe(true);
    expect(t.judged("a", verdict(false), STUCK_CHECK_MS)).toBe("none");
    expect(t.observe("a", S(), STUCK_CHECK_MS * 2)).toBe(false);
    expect(t.observe("a", S(), STUCK_CHECK_MS + STUCK_REJUDGE_MS - 1)).toBe(false);
    expect(t.state("a").stuck).toBe(false);
    // 间隔太长会清零；中间持续观察
    let at = STUCK_CHECK_MS * 2;
    while (at < STUCK_CHECK_MS + STUCK_REJUDGE_MS) t.observe("a", S(), (at += STUCK_CHECK_MS));
    expect(t.observe("a", S(), at + STUCK_CHECK_MS)).toBe(true);
  });

  it("judged(stuck:true) 返回 newly_stuck，同一次卡住再判断返回 none", () => {
    const t = new StuckTracker();
    t.observe("a", S(), 0);
    t.observe("a", S(), STUCK_CHECK_MS);
    expect(t.judged("a", { stuck: true, reason: "等输入", action: "回车" }, STUCK_CHECK_MS)).toBe("newly_stuck");
    expect(t.state("a")).toEqual({ stuck: true, reason: "等输入", action: "回车" });
    expect(t.observe("a", S(), STUCK_CHECK_MS * 2)).toBe(false);
    expect(t.judged("a", verdict(true), STUCK_CHECK_MS * 2)).toBe("none");
  });

  it("judged(null) 后下一轮可疑时可以再试", () => {
    const t = new StuckTracker();
    t.observe("a", S(), 0);
    expect(t.observe("a", S(), STUCK_CHECK_MS)).toBe(true);
    expect(t.judged("a", null, STUCK_CHECK_MS)).toBe("none");
    expect(t.observe("a", S(), STUCK_CHECK_MS * 2)).toBe(true);
  });

  it("有变化时 stuck 自动清除，再次卡住可再次通知", () => {
    const t = new StuckTracker();
    t.observe("a", S(), 0);
    t.observe("a", S(), STUCK_CHECK_MS);
    t.judged("a", verdict(true), STUCK_CHECK_MS);
    t.observe("a", S({ outputSize: 99 }), STUCK_CHECK_MS * 2);
    expect(t.state("a")).toEqual({ stuck: false, reason: null, action: null });
    expect(t.observe("a", S({ outputSize: 99 }), STUCK_CHECK_MS * 3)).toBe(false);
    expect(t.observe("a", S({ outputSize: 99 }), STUCK_CHECK_MS * 4)).toBe(true);
    expect(t.judged("a", verdict(true), STUCK_CHECK_MS * 4)).toBe("newly_stuck");
  });

  it("dismiss 后不再标记，直到有变化后再次安静", () => {
    const t = new StuckTracker();
    t.observe("a", S(), 0);
    t.observe("a", S(), STUCK_CHECK_MS);
    t.judged("a", verdict(true), STUCK_CHECK_MS);
    t.dismiss("a");
    expect(t.state("a").stuck).toBe(false);
    expect(t.observe("a", S(), STUCK_CHECK_MS * 2)).toBe(false);
    expect(t.observe("a", S(), STUCK_CHECK_MS * 3)).toBe(false);
    t.observe("a", S({ transcriptSize: 200 }), STUCK_CHECK_MS * 4);
    expect(t.observe("a", S({ transcriptSize: 200 }), STUCK_CHECK_MS * 5)).toBe(false);
    expect(t.observe("a", S({ transcriptSize: 200 }), STUCK_CHECK_MS * 6)).toBe(true);
  });
});
