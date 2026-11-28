import { describe, expect, it } from "vitest";
import type { FlowChange } from "../../shared/infoflow";
import {
  alreadyDone, applyChange, undoFor, autoEligible, changeSignature, parseChange, parseUndo, resolveChange, stillValid, undoChange,
  type ActionWorld, type TicketActions,
} from "./actions";
import type { RawChange } from "./extract";

function world() {
  const tickets = new Map([
    ["BTL-12", { key: "BTL-12", featureId: 4, blockId: 1 as number | null, closed: false }],
    ["BTL-13", { key: "BTL-13", featureId: 4, blockId: 2 as number | null, closed: false }],
    ["SOLO-1", { key: "SOLO-1", featureId: null as number | null, blockId: null as number | null, closed: false }],
  ]);
  const blocks = [
    { id: 1, featureId: 4, name: "登录" },
    { id: 2, featureId: 4, name: "导出" },
    { id: 3, featureId: 4, name: "设置" },
    { id: 9, featureId: 5, name: "报表" },
  ];
  const order = new Map<number, number[]>([[4, [1, 2, 3]], [5, [9]]]);
  const calls: string[] = [];
  const w: ActionWorld = {
    ticket: (k) => [...tickets.values()].find((t) => t.key.toLowerCase() === k.trim().toLowerCase()) ?? null,
    block: (epic, ref) => {
      const hits = blocks.filter((b) => (epic === null || b.featureId === epic) && (b.id === Number(ref) || b.name.toLowerCase() === String(ref).trim().toLowerCase()));
      return hits.length === 1 ? { id: hits[0].id, featureId: hits[0].featureId } : null;
    },
    blockOrder: (f) => order.get(f) ?? [],
  };
  const act: TicketActions = {
    closeTicket: async (k, reason, closePrs) => {
      calls.push(`close ${k} ${reason}${closePrs ? " +prs" : ""}`);
      tickets.get(k)!.closed = true;
      return closePrs ? { kind: "partial", leftovers: { prErrors: [{ url: "#7", error: "gh failed", kind: "failed" }], sessionErrors: [] } } : { kind: "done" };
    },
    retryClose: async (k) => {
      calls.push(`retry ${k}`);
      return { kind: "done" };
    },
    previewClose: async () => ({ closable: ["#7"], unclosable: [] }),
    reopenTicket: async (k) => {
      calls.push(`reopen ${k}`);
      tickets.get(k)!.closed = false;
    },
    setBlock: (k, b) => {
      calls.push(`block ${k} ${b}`);
      tickets.get(k)!.blockId = b;
    },
    reorderBlocks: (f, ids) => {
      calls.push(`order ${f} ${ids.join(",")}`);
      order.set(f, ids);
    },
  };
  return { w, act, calls, tickets, order, blocks };
}

const raw = (o: Partial<RawChange>): RawChange => ({ op: "close_ticket", ticket: null, feature: undefined, reason: null, closePrs: false, ...o });

describe("resolveChange", () => {
  const { w } = world();
  it("checks tickets and features against Shipherd", () => {
    expect(resolveChange(raw({ ticket: "btl-12", reason: "需求变了" }), w, 4)).toEqual({ op: "close_ticket", ticket: "BTL-12", reason: "需求变了", closePrs: false });
    expect(resolveChange(raw({ ticket: "BTL-99" }), w, 4)).toBeNull();
    expect(resolveChange(raw({ op: "set_ticket_feature", ticket: "BTL-12", feature: "导出" }), w, null)).toEqual({ op: "set_ticket_feature", ticket: "BTL-12", blockId: 2 });
    expect(resolveChange(raw({ op: "set_ticket_feature", ticket: "BTL-12", feature: null }), w, null)).toEqual({ op: "set_ticket_feature", ticket: "BTL-12", blockId: null });
    // 别的 epic 的 feature、不存在的 feature、没说换到哪、ticket 不属于 epic：都不认。
    expect(resolveChange(raw({ op: "set_ticket_feature", ticket: "BTL-12", feature: "报表" }), w, null)).toBeNull();
    expect(resolveChange(raw({ op: "set_ticket_feature", ticket: "BTL-12", feature: "nope" }), w, null)).toBeNull();
    expect(resolveChange(raw({ op: "set_ticket_feature", ticket: "BTL-12" }), w, null)).toBeNull();
    expect(resolveChange(raw({ op: "set_ticket_feature", ticket: "SOLO-1", feature: "导出" }), w, null)).toBeNull();
  });

  it("finds the feature to do first in the source's epic; anywhere only when there is no epic", () => {
    expect(resolveChange(raw({ op: "prioritize_feature", feature: "设置" }), w, 4)).toEqual({ op: "prioritize_feature", featureId: 4, blockId: 3 });
    expect(resolveChange(raw({ op: "prioritize_feature", feature: "报表" }), w, null)).toEqual({ op: "prioritize_feature", featureId: 5, blockId: 9 });
    // 来源在 epic 4，epic 4 里没有「报表」：不去 epic 5 找（会把不相干的 epic 排了序）。
    expect(resolveChange(raw({ op: "prioritize_feature", feature: "报表" }), w, 4)).toBeNull();
    expect(resolveChange(raw({ op: "prioritize_feature", ticket: "BTL-12", feature: "报表" }), w, null)).toBeNull();
    expect(resolveChange(raw({ op: "prioritize_feature", feature: 2 }), w, 4)).toEqual({ op: "prioritize_feature", featureId: 4, blockId: 2 });
    expect(resolveChange(raw({ op: "prioritize_feature", feature: null }), w, 4)).toBeNull();
  });
});

describe("autoEligible", () => {
  const change: FlowChange = { op: "close_ticket", ticket: "BTL-12", reason: "", closePrs: false };
  const base = { enabled: true, change, speaker: "user" as const, fromUser: true, quote: "BTL-12 不做了", userText: "嗯，btl-12 不做了，需求变了", confidence: 0.9 };
  it("runs only what the user clearly said", () => {
    expect(autoEligible(base)).toBe(true);
    expect(autoEligible({ ...base, enabled: false })).toBe(false);
    expect(autoEligible({ ...base, speaker: "agent" })).toBe(false);
    expect(autoEligible({ ...base, fromUser: false })).toBe(false);
    expect(autoEligible({ ...base, confidence: 0.6 })).toBe(false);
    expect(autoEligible({ ...base, quote: "BTL-12 先不做" })).toBe(false);
    expect(autoEligible({ ...base, quote: "做了" })).toBe(false);
  });

  it("matches English hedges as whole words: if in notify, not in another, think in rethink don't count", () => {
    const en = (userText: string, quote = "close BTL-12") => autoEligible({ ...base, quote, userText });
    expect(en("Close BTL-12 and notify the team.")).toBe(true);
    expect(en("Another thing: close BTL-12.")).toBe(true);
    expect(en("We rethought it, close BTL-12.")).toBe(true);
    expect(en("Close BTL-12, the gift card flow is gone.")).toBe(true);
    // 真正的否定、条件、犹豫照样拦住。
    expect(en("I don't think we should close BTL-12.")).toBe(false);
    expect(en("If the demo fails, close BTL-12.")).toBe(false);
    expect(en("Close BTL-12 if the demo fails.")).toBe(false);
    expect(en("Maybe close BTL-12.")).toBe(false);
    expect(en("Do not close BTL-12.", "not close BTL-12")).toBe(false);
  });

  it("still finds the quote when the user pasted a secret in that sentence (both sides are masked the same)", () => {
    const tok = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    expect(autoEligible({ ...base, quote: "BTL-12 不做了，[REDACTED] 作废", userText: `BTL-12 不做了，${tok} 作废` })).toBe(true);
  });

  it("does not run what the user said not to do", () => {
    const c2: FlowChange = { op: "close_ticket", ticket: "BTL-12", reason: "", closePrs: false };
    const neg = { ...base, change: c2, quote: "关闭 BTL-12" };
    expect(autoEligible({ ...neg, userText: "关闭 BTL-12，需求变了" })).toBe(true);
    expect(autoEligible({ ...neg, userText: "先不要关闭 BTL-12，等下周再说" })).toBe(false);
    expect(autoEligible({ ...neg, userText: "别关闭BTL-12" })).toBe(false);
    expect(autoEligible({ ...neg, userText: "don't close BTL-12 yet", quote: "close BTL-12" })).toBe(false);
    // 模型把否定也抄进了原话。
    expect(autoEligible({ ...neg, userText: "不要关闭 BTL-12", quote: "不要关闭 BTL-12" })).toBe(false);
    // 出现两次、其中一次被否定：不算。
    expect(autoEligible({ ...neg, userText: "关闭 BTL-12？不，不要关闭 BTL-12" })).toBe(false);
    // 「不做了」本身就是关的说法。
    expect(autoEligible({ ...neg, quote: "BTL-12 不做了", userText: "BTL-12 不做了，需求变了" })).toBe(true);
  });

  it("asks when the user hedges, negates earlier in the sentence or asks a question", () => {
    const close = { ...base, quote: "close BTL-12" };
    expect(autoEligible({ ...close, userText: "Close BTL-12, the customer dropped it." })).toBe(true);
    for (const userText of [
      "I don't think we should close BTL-12 yet",
      "We shouldn't close BTL-12",
      "We won't close BTL-12 this week",
      "No need to close BTL-12",
      "Maybe close BTL-12",
      "If the demo fails, close BTL-12",
      "Should we close BTL-12?",
    ]) expect(autoEligible({ ...close, userText }), userText).toBe(false);
    const zh = { ...base, quote: "关闭 BTL-12" };
    for (const userText of ["要不要关闭 BTL-12", "也许关闭 BTL-12 比较好", "关闭 BTL-12 吗", "如果客户不要了就关闭 BTL-12", "我觉得可能关闭 BTL-12 好一点"]) {
      expect(autoEligible({ ...zh, userText }), userText).toBe(false);
    }
    // 前一句里的否定不管后一句。
    expect(autoEligible({ ...zh, userText: "这个不急。关闭 BTL-12" })).toBe(true);
  });

  it("asks when the condition is inside the quote or comes after it in the same sentence", () => {
    const en = "If the demo fails, close BTL-12";
    // 模型把条件也抄进了原话。
    expect(autoEligible({ ...base, quote: en, userText: en })).toBe(false);
    expect(autoEligible({ ...base, quote: "如果演示没过就关闭 BTL-12", userText: "如果演示没过就关闭 BTL-12" })).toBe(false);
    expect(autoEligible({ ...base, quote: "也许 BTL-12 不做了", userText: "也许 BTL-12 不做了" })).toBe(false);
    // 条件跟在原话后面（同一句）。
    expect(autoEligible({ ...base, quote: "close BTL-12", userText: "Close BTL-12 if the demo fails" })).toBe(false);
    expect(autoEligible({ ...base, quote: "关闭 BTL-12", userText: "关闭 BTL-12，如果演示没过的话" })).toBe(false);
    // 原话里、后面只有表示取消的「不」（不做了、不用关 PR）照样执行；下一句的条件不管这一句。
    expect(autoEligible({ ...base, quote: "BTL-12 不做了", userText: "BTL-12 不做了，不用再管它" })).toBe(true);
    expect(autoEligible({ ...base, quote: "关闭 BTL-12", userText: "关闭 BTL-12。如果以后客户又要，再开一个" })).toBe(true);
  });

  it("always asks before closing PRs", () => {
    expect(autoEligible({ ...base, change: { ...change, closePrs: true } })).toBe(false);
  });
});

describe("apply, undo and idempotency", () => {
  it("closes and reopens", async () => {
    const { w, act, calls } = world();
    const c: FlowChange = { op: "close_ticket", ticket: "BTL-12", reason: "需求变了", closePrs: false };
    expect(alreadyDone(c, w)).toBe(false);
    const undo = undoFor(c, w);
    await applyChange(c, w, act, "fallback");
    expect(alreadyDone(c, w)).toBe(true);
    await undoChange(undo, w, act);
    expect(calls).toEqual(["close BTL-12 需求变了", "reopen BTL-12"]);
  });

  it("passes closePrs on and fills an empty reason (closeTicket refuses an empty one)", async () => {
    const { w, act, calls } = world();
    const r = await applyChange({ op: "close_ticket", ticket: "BTL-12", reason: "  ", closePrs: true }, w, act, "对话里说不做了");
    expect(calls).toEqual(["close BTL-12 对话里说不做了 +prs"]);
    // ticket 关了、有 PR 没关上：没处理完的原样带回去（调用方记成 partial，撤销用的旧状态执行前已经存下）。
    expect(r).toEqual({ kind: "partial", leftovers: { prErrors: [{ url: "#7", error: "gh failed", kind: "failed" }], sessionErrors: [] } });
  });

  it("masks the reason before it goes out (it becomes the PR comment on GitHub)", async () => {
    const { w, act, calls } = world();
    const tok = "glpat-" + "a1B2c3D4e5F6g7H8i9J0";
    await applyChange({ op: "close_ticket", ticket: "BTL-12", reason: `泄露了 ${tok}`, closePrs: false }, w, act, "fallback");
    expect(calls).toEqual(["close BTL-12 泄露了 [REDACTED]"]);
  });

  it("moves a ticket and moves it back", async () => {
    const { w, act, tickets } = world();
    const c: FlowChange = { op: "set_ticket_feature", ticket: "BTL-12", blockId: 3 };
    const undo = undoFor(c, w);
    await applyChange(c, w, act, "fallback");
    expect(tickets.get("BTL-12")!.blockId).toBe(3);
    await undoChange(undo, w, act);
    expect(tickets.get("BTL-12")!.blockId).toBe(1);
  });

  it("puts a feature first and restores the order, keeping features added since", async () => {
    const { w, act, order } = world();
    const c: FlowChange = { op: "prioritize_feature", featureId: 4, blockId: 3 };
    const undo = undoFor(c, w);
    await applyChange(c, w, act, "fallback");
    expect(order.get(4)).toEqual([3, 1, 2]);
    expect(alreadyDone(c, w)).toBe(true);
    order.set(4, [3, 1, 2, 7]);
    await undoChange(undo, w, act);
    expect(order.get(4)).toEqual([1, 2, 3, 7]);
  });

  it("notices a change that is already in place", () => {
    const { w, tickets } = world();
    tickets.get("BTL-13")!.closed = true;
    expect(alreadyDone({ op: "close_ticket", ticket: "BTL-13", reason: "", closePrs: false }, w)).toBe(true);
    expect(alreadyDone({ op: "set_ticket_feature", ticket: "BTL-12", blockId: 1 }, w)).toBe(true);
    expect(alreadyDone({ op: "prioritize_feature", featureId: 4, blockId: 1 }, w)).toBe(true);
  });

  it("gives the same signature to the same change", () => {
    expect(changeSignature({ op: "close_ticket", ticket: "BTL-12", reason: "a", closePrs: false })).toBe(
      changeSignature({ op: "close_ticket", ticket: "BTL-12", reason: "b", closePrs: true }),
    );
    expect(changeSignature({ op: "set_ticket_feature", ticket: "BTL-12", blockId: 1 })).not.toBe(changeSignature({ op: "set_ticket_feature", ticket: "BTL-12", blockId: 2 }));
  });

  it("knows when a waiting change can no longer run", () => {
    const { w, blocks, tickets } = world();
    expect(stillValid({ op: "set_ticket_feature", ticket: "BTL-12", blockId: 3 }, w)).toBe(true);
    blocks.splice(2, 1);
    expect(stillValid({ op: "set_ticket_feature", ticket: "BTL-12", blockId: 3 }, w)).toBe(false);
    tickets.delete("BTL-13");
    expect(stillValid({ op: "close_ticket", ticket: "BTL-13", reason: "", closePrs: false }, w)).toBe(false);
    expect(stillValid({ op: "prioritize_feature", featureId: 4, blockId: 42 }, w)).toBe(false);
  });
});

describe("stored JSON", () => {
  it("round-trips and rejects junk", () => {
    const c: FlowChange = { op: "set_ticket_feature", ticket: "BTL-12", blockId: null };
    expect(parseChange(JSON.stringify(c))).toEqual(c);
    expect(parseChange("{")).toBeNull();
    expect(parseChange(JSON.stringify({ op: "drop_db" }))).toBeNull();
    expect(parseUndo(JSON.stringify({ op: "reorder_features", featureId: 4, order: [1, 2] }))).toEqual({ op: "reorder_features", featureId: 4, order: [1, 2] });
    expect(parseUndo(JSON.stringify({ op: "reorder_features", featureId: 4, order: ["x"] }))).toBeNull();
    expect(parseUndo(null)).toBeNull();
  });
});
