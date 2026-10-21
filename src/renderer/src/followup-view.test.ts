import { describe, expect, it } from "vitest";
import type { Followup } from "../../shared/types";
import { followupMeta, outcomeMessage, splitFollowups, triggerLabel } from "./followup-view";

const f = (id: string, over: Partial<Followup> = {}): Followup => ({
  id, ticketKey: "A-1", kind: "config", description: id, trigger: "after_merge", dueDate: null,
  status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null, ...over,
});

describe("followup view helpers", () => {
  it("splits active (open, snoozed) from closed (done, ignored)", () => {
    const { active, closed } = splitFollowups([f("a"), f("b", { status: "snoozed" }), f("c", { status: "done" }), f("d", { status: "ignored" })]);
    expect(active.map((x) => x.id)).toEqual(["a", "b"]);
    expect(closed.map((x) => x.id)).toEqual(["c", "d"]);
  });

  it("describes kind, trigger, due date and snooze", () => {
    expect(followupMeta(f("a"))).toBe("配置 · 合并后");
    expect(followupMeta(f("a", { kind: "flag", trigger: "on_date", dueDate: "2026-10-30", status: "snoozed", snoozedUntil: "2026-10-22" }))).toBe(
      "开关 · 到期日 · 2026-10-30 · 推迟到 2026-10-22",
    );
    expect(followupMeta(f("a", { status: "ignored" }))).toBe("配置 · 合并后 · 已忽略");
  });

  it("explains each handoff outcome", () => {
    expect(outcomeMessage({ ticketKey: "A-1", status: "stored", handoffId: 1, degraded: false })).toBe("handoff 已更新。");
    expect(outcomeMessage({ ticketKey: "A-1", status: "stored", handoffId: 1, degraded: true })).toContain("不完整");
    expect(outcomeMessage({ ticketKey: "A-1", status: "skipped", reason: "rate_limited" })).toContain("限流");
    expect(outcomeMessage({ ticketKey: "A-1", status: "failed", reason: "timeout", message: "超过 300 秒没有完成" })).toBe("handoff 失败：超过 300 秒没有完成");
    expect(triggerLabel("command")).toBe("/handoff");
  });
});
