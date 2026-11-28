import { describe, expect, it } from "vitest";
import type { FlowActionView } from "../../shared/infoflow";
import { STRINGS } from "./strings";
import { flowActionButtons, flowActionText, flowDeliveryText, flowMemoryText } from "./infoflow-view";

const action = (o: Partial<FlowActionView>): FlowActionView => ({
  id: 1, change: { op: "close_ticket", ticket: "BTL-12", reason: "需求变了", closePrs: false }, label: "关掉 BTL-12", mode: "auto", state: "applied", error: null, leftovers: null, undoable: true, decidedAt: null, ...o,
});

describe("info flow view (BTL-272)", () => {
  it("says where the item went and how far the sync got, in both languages", () => {
    const zh = STRINGS.zh;
    const en = STRINGS.en;
    expect(flowMemoryText({ memory: "written", scope: "ticket:BTL-12" }, zh)).toBe("记进了 ticket:BTL-12");
    expect(flowMemoryText({ memory: "dup", scope: null }, en)).toBe(en.infoflow.memory.dup);
    const deliveries = [
      { toSession: "a", to: "BTL-12", status: "delivered" as const, deliveredAt: null },
      { toSession: "b", to: "epic", status: null, deliveredAt: null },
    ];
    expect(flowDeliveryText({ deliveries }, zh)).toBe("发给 BTL-12（已送到）、epic（已清理）");
    expect(flowDeliveryText({ deliveries }, en)).toBe(`${en.infoflow.sentTo} BTL-12 (Delivered), epic (Cleared)`);
    expect(flowDeliveryText({ deliveries: [] }, zh)).toBe(zh.infoflow.notSent);
    expect(flowActionText(action({}), zh)).toBe("关掉 BTL-12 · 已同步（自动）");
    expect(flowActionText(action({ mode: "confirm", state: "pending" }), zh)).toBe("关掉 BTL-12 · 等你确认");
    expect(flowActionText(action({ state: "failed", error: "boom" }), en)).toContain("boom");
  });

  it("offers apply/reject while waiting and undo only when it can be undone", () => {
    expect(flowActionButtons(action({ state: "pending" }))).toEqual(["apply", "reject"]);
    expect(flowActionButtons(action({}))).toEqual(["undo"]);
    expect(flowActionButtons(action({ undoable: false }))).toEqual([]);
    expect(flowActionButtons(action({ state: "undone", undoable: false }))).toEqual([]);
  });

  it("shows a half-done close as not done, with each reason, retry and leave-it", () => {
    const leftovers = { prErrors: [{ url: "https://x/pull/41", error: "gh: 502", kind: "failed" as const }], sessionErrors: [{ id: "1a2b3c4d5e", error: "busy" }] };
    const a = action({ state: "partial", leftovers, error: "x" });
    const zh = STRINGS.zh;
    const text = flowActionText(a, zh);
    expect(text).not.toContain(zh.infoflow.action.applied);
    expect(text).toContain("https://x/pull/41（gh 出错：gh: 502）");
    expect(text).toContain("session 1a2b3c4d（busy）");
    expect(flowActionText(a, STRINGS.en)).toContain("https://x/pull/41");
    expect(flowActionButtons(a)).toEqual(["retry", "accept", "undo"]);
    expect(flowActionButtons({ ...a, undoable: false })).toEqual(["retry", "accept"]);
    // 剩下的都是再试也关不了的（BTL-270 的 retryRequest 是 null）：不给重试。
    const stuck = { prErrors: [{ url: "https://x/pull/41", error: "BTL-13", kind: "shared" as const }], sessionErrors: [] };
    expect(flowActionButtons({ ...a, leftovers: stuck })).toEqual(["accept", "undo"]);
    expect(flowActionButtons({ ...a, leftovers: stuck, undoable: false })).toEqual(["accept"]);
  });

  // BTL-270 的 closedMeanwhile：关的时候别人先关了这个 ticket。
  it("says someone else closed it first: already with what was done, partial with the reasons and no undo", () => {
    for (const L of [STRINGS.zh, STRINGS.en]) {
      const already = action({ state: "already", error: "note", undoable: false });
      expect(flowActionText(already, L)).toBe(`关掉 BTL-12 · ${L.infoflow.withAuto(L.infoflow.action.alreadyNote("note"))}`);
      expect(flowActionButtons(already)).toEqual([]);
      // 没有说明的 already 照旧。
      expect(flowActionText(action({ state: "already", mode: "confirm" }), L)).toBe(`关掉 BTL-12 · ${L.infoflow.action.already}`);
      const leftovers = { prErrors: [{ url: "https://x/pull/41", error: "gh: 502", kind: "failed" as const }], sessionErrors: [], closedMeanwhile: true as const };
      const partial = action({ state: "partial", mode: "confirm", leftovers, error: "x", undoable: false });
      expect(flowActionText(partial, L)).toBe(`关掉 BTL-12 · ${L.infoflow.action.partialClosedMeanwhile(L.infoflow.leftPr("https://x/pull/41", L.tc.prKind.failed, "gh: 502"))}`);
      expect(flowActionButtons(partial)).toEqual(["retry", "accept"]);
    }
    expect(flowActionText(action({ state: "already", error: "x", mode: "confirm" }), STRINGS.zh)).toBe("关掉 BTL-12 · 本来就是这样：x");
  });
});
