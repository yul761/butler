import { describe, expect, it } from "vitest";
import { cpuQuiet, CPU_CHANGE_MS, STUCK_CHECK_MS, STUCK_REJUDGE_MS, StuckTracker, type StuckSample } from "./stuck-tracker";

const C = STUCK_CHECK_MS;
const S = (o: Partial<StuckSample> = {}): StuckSample => ({ transcriptSize: 100, outputSize: 50, childCpuMs: 1000, eligible: true, ...o });
const verdict = (stuck: boolean) => ({ stuck, reason: "r", action: "a" });
/** 基线加一次没变化的比较，下一次没变化就该返回 true。 */
function primed(sample = S()): StuckTracker {
  const t = new StuckTracker();
  t.observe("a", sample, 0);
  expect(t.observe("a", sample, C)).toBe(false);
  return t;
}

describe("cpuQuiet", () => {
  it("两次读数相差不到 CPU_CHANGE_MS 算安静，两个方向都一样", () => {
    expect(cpuQuiet(1000, 1000 + CPU_CHANGE_MS - 1)).toBe(true);
    expect(cpuQuiet(1000, 1000 + CPU_CHANGE_MS)).toBe(false);
    // 用过 CPU 的子进程退出时，累计值会变小
    expect(cpuQuiet(1000 + CPU_CHANGE_MS, 1000)).toBe(false);
  });

  it("任何一次读不到都返回 null", () => {
    expect(cpuQuiet(null, 1000)).toBeNull();
    expect(cpuQuiet(1000, null)).toBeNull();
    expect(cpuQuiet(null, null)).toBeNull();
  });
});

describe("StuckTracker", () => {
  it("基线之后连续两次没变化，第二次返回 true", () => {
    const t = new StuckTracker();
    expect(t.observe("a", S(), 0)).toBe(false);
    expect(t.observe("a", S(), C)).toBe(false);
    expect(t.observe("a", S(), C * 2)).toBe(true);
  });

  it("任何一项有变化都会让计数清零", () => {
    for (const change of [{ transcriptSize: 101 }, { outputSize: 51 }, { childCpuMs: 1000 + CPU_CHANGE_MS }]) {
      const t = primed();
      expect(t.observe("a", S(change), C * 2)).toBe(false);
      expect(t.observe("a", S(change), C * 3)).toBe(false);
      expect(t.observe("a", S(change), C * 4)).toBe(true);
    }
  });

  it("childCpuMs 变化小于 2000 不算变化；null 时只看另外两项", () => {
    const t = primed();
    expect(t.observe("a", S({ childCpuMs: 1000 + CPU_CHANGE_MS - 1 }), C * 2)).toBe(true);
    const n = primed(S({ childCpuMs: null }));
    expect(n.observe("a", S({ childCpuMs: null }), C * 2)).toBe(true);
    const m = new StuckTracker();
    m.observe("a", S({ childCpuMs: 5000 }), 0);
    m.observe("a", S({ childCpuMs: null }), C);
    expect(m.observe("a", S({ childCpuMs: null }), C * 2)).toBe(true);
  });

  it("eligible 为 false 时计数清零且返回 false，之后重新建立基线", () => {
    const t = primed();
    expect(t.observe("a", S({ eligible: false }), C * 2)).toBe(false);
    expect(t.observe("a", S(), C * 3)).toBe(false); // 基线
    expect(t.observe("a", S(), C * 4)).toBe(false);
    expect(t.observe("a", S(), C * 5)).toBe(true);
  });

  it("两次检查间隔超过 STUCK_CHECK_MS * 2 时计数清零", () => {
    const t = primed();
    const late = C + C * 2 + 1;
    expect(t.observe("a", S(), late)).toBe(false); // 重新建立基线
    expect(t.observe("a", S(), late + C)).toBe(false);
    expect(t.observe("a", S(), late + C * 2)).toBe(true);
  });

  it("eligible 为 false 不影响 judged(stuck:false) 的静默期", () => {
    const t = primed();
    t.observe("a", S(), C * 2);
    t.judged("a", verdict(false), C * 2);
    t.observe("a", S({ eligible: false }), C * 2 + 1);
    expect(t.observe("a", S(), C * 2 + 2)).toBe(false); // 基线
    expect(t.observe("a", S(), C * 3)).toBe(false);
    // 够可疑了，但还在静默期里
    expect(t.observe("a", S(), C * 4)).toBe(false);
    expect(C * 4).toBeLessThan(C * 2 + STUCK_REJUDGE_MS);
    expect(t.observe("a", S(), C * 2 + STUCK_REJUDGE_MS)).toBe(true);
  });

  it("间隔太久不影响 judged(stuck:false) 的静默期", () => {
    const t = primed();
    t.observe("a", S(), C * 2);
    t.judged("a", verdict(false), C * 2);
    const late = C * 4 + 1;
    expect(t.observe("a", S(), late)).toBe(false);
    expect(t.observe("a", S(), late + 1)).toBe(false);
    expect(t.observe("a", S(), late + 2)).toBe(false);
    expect(t.observe("a", S(), C * 2 + STUCK_REJUDGE_MS)).toBe(true);
  });

  it("只有 forget 清掉静默期", () => {
    const t = primed();
    t.observe("a", S(), C * 2);
    t.judged("a", verdict(false), C * 2);
    t.forget("a");
    t.observe("a", S(), C * 2 + 1);
    t.observe("a", S(), C * 2 + 2);
    expect(t.observe("a", S(), C * 2 + 3)).toBe(true);
  });

  it("eligible 为 false 时清掉卡住和忽略的标记，也不留下可以被标记的记录", () => {
    const t = primed();
    t.observe("a", S(), C * 2);
    t.judged("a", verdict(true), C * 2);
    t.observe("a", S({ eligible: false }), C * 3);
    expect(t.state("a")).toEqual({ stuck: false, reason: null, action: null });
    // 判断结果迟到：还没有新的基线，不算数
    expect(t.judged("a", verdict(true), C * 3)).toBe("none");
    expect(t.state("a").stuck).toBe(false);
  });

  it("没有记录时 eligible 为 false 什么都不做", () => {
    const t = new StuckTracker();
    expect(t.observe("a", S({ eligible: false }), 0)).toBe(false);
    expect(t.state("a")).toEqual({ stuck: false, reason: null, action: null });
  });

  it("间隔太久只重新计数：卡住的标记留着，不会再通知一次", () => {
    const t = primed();
    t.observe("a", S(), C * 2);
    t.judged("a", { stuck: true, reason: "等输入", action: "回车" }, C * 2);
    const late = C * 4 + 1;
    expect(t.observe("a", S(), late)).toBe(false);
    expect(t.state("a")).toEqual({ stuck: true, reason: "等输入", action: "回车" });
    expect(t.observe("a", S(), late + C)).toBe(false);
    expect(t.observe("a", S(), late + C * 2)).toBe(false);
    expect(t.judged("a", verdict(true), late + C * 2)).toBe("none");
  });

  it("间隔太久时忽略的标记也留着", () => {
    const t = primed();
    t.observe("a", S(), C * 2);
    t.judged("a", verdict(true), C * 2);
    t.dismiss("a");
    const late = C * 4 + 1;
    expect(t.observe("a", S(), late)).toBe(false);
    expect(t.observe("a", S(), late + C)).toBe(false);
    expect(t.observe("a", S(), late + C * 2)).toBe(false);
    expect(t.state("a").stuck).toBe(false);
  });

  it("间隔太久之后真的有变化，照样清掉卡住和忽略的标记", () => {
    const stuck = primed();
    stuck.observe("a", S(), C * 2);
    stuck.judged("a", verdict(true), C * 2);
    stuck.observe("a", S({ outputSize: 99 }), C * 4 + 1);
    expect(stuck.state("a").stuck).toBe(false);

    const dismissed = primed();
    dismissed.observe("a", S(), C * 2);
    dismissed.judged("a", verdict(true), C * 2);
    dismissed.dismiss("a");
    const late = C * 4 + 1;
    dismissed.observe("a", S({ outputSize: 99 }), late);
    expect(dismissed.observe("a", S({ outputSize: 99 }), late + C)).toBe(false);
    expect(dismissed.observe("a", S({ outputSize: 99 }), late + C * 2)).toBe(true);
    expect(dismissed.judged("a", verdict(true), late + C * 2)).toBe("newly_stuck");
  });

  it("不同 id 互不影响，forget 后重新开始", () => {
    const t = primed();
    expect(t.observe("b", S(), C * 2)).toBe(false);
    t.forget("a");
    expect(t.observe("a", S(), C * 2)).toBe(false);
    expect(t.observe("a", S(), C * 3)).toBe(false);
    expect(t.observe("a", S(), C * 4)).toBe(true);
  });

  it("judged(stuck:false) 后 10 分钟内 observe 不返回 true", () => {
    const t = primed();
    expect(t.observe("a", S(), C * 2)).toBe(true);
    expect(t.judged("a", verdict(false), C * 2)).toBe("none");
    let at = C * 2;
    while (at + C < C * 2 + STUCK_REJUDGE_MS) expect(t.observe("a", S(), (at += C))).toBe(false);
    expect(t.state("a").stuck).toBe(false);
    expect(t.observe("a", S(), at + C)).toBe(true);
  });

  it("judged(stuck:true) 返回 newly_stuck，同一次卡住再判断返回 none", () => {
    const t = primed();
    t.observe("a", S(), C * 2);
    expect(t.judged("a", { stuck: true, reason: "等输入", action: "回车" }, C * 2)).toBe("newly_stuck");
    expect(t.state("a")).toEqual({ stuck: true, reason: "等输入", action: "回车" });
    expect(t.observe("a", S(), C * 3)).toBe(false);
    expect(t.judged("a", verdict(true), C * 3)).toBe("none");
  });

  it("judged(null) 后下一轮可疑时可以再试", () => {
    const t = primed();
    expect(t.observe("a", S(), C * 2)).toBe(true);
    expect(t.judged("a", null, C * 2)).toBe("none");
    expect(t.observe("a", S(), C * 3)).toBe(true);
  });

  it("有变化时 stuck 自动清除，再次卡住可再次通知", () => {
    const t = primed();
    t.observe("a", S(), C * 2);
    t.judged("a", verdict(true), C * 2);
    t.observe("a", S({ outputSize: 99 }), C * 3);
    expect(t.state("a")).toEqual({ stuck: false, reason: null, action: null });
    expect(t.observe("a", S({ outputSize: 99 }), C * 4)).toBe(false);
    expect(t.observe("a", S({ outputSize: 99 }), C * 5)).toBe(true);
    expect(t.judged("a", verdict(true), C * 5)).toBe("newly_stuck");
  });

  it("dismiss 后不再标记，直到有变化后再次安静", () => {
    const t = primed();
    t.observe("a", S(), C * 2);
    t.judged("a", verdict(true), C * 2);
    t.dismiss("a");
    expect(t.state("a").stuck).toBe(false);
    expect(t.observe("a", S(), C * 3)).toBe(false);
    expect(t.observe("a", S(), C * 4)).toBe(false);
    t.observe("a", S({ transcriptSize: 200 }), C * 5);
    expect(t.observe("a", S({ transcriptSize: 200 }), C * 6)).toBe(false);
    expect(t.observe("a", S({ transcriptSize: 200 }), C * 7)).toBe(true);
  });

  it("uses the check interval it was given for the gap rule", () => {
    const t = new StuckTracker(1000);
    t.observe("a", S(), 0);
    t.observe("a", S(), 1000);
    expect(t.observe("a", S(), 2000)).toBe(true);
    const gap = new StuckTracker(1000);
    gap.observe("a", S(), 0);
    gap.observe("a", S(), 1000);
    expect(gap.observe("a", S(), 3001)).toBe(false);
  });
});
