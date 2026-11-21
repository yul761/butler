import { describe, expect, it } from "vitest";
import type { ConvMessage } from "../../shared/conversation";
import type { DevSendBlock, ForkErrorCode, ForkRefusal, ForkView, RememberResult } from "../../shared/fork";
import type { InboxItemView } from "../../shared/types";
import { resetClock } from "./availability-view";
import { TASK_LIMIT } from "../../shared/control";
import { FORK_QUESTION_MAX } from "../../shared/fork";
import { buildTimeline, canRememberIn, costText, draftCheck, errorText, keepSelection, lastQuestion, latestOnly, mergeConvPage, mergeReportPage, modeText, queuedText, refusalText, rememberText, refusesMemory, sendBlockText, turnBlocks, type TimelineInput } from "./conversation-view";
import { STRINGS } from "./strings";

const T = STRINGS.zh;

const msg = (id: number, at: number, over: Partial<ConvMessage> = {}): ConvMessage => ({
  id, rootSessionId: "r", sessionId: "s1", role: "assistant", text: `m${id}`, at, forkId: null, qa: true, turnId: id, ...over,
});
const fork = (id: number, startedAt: number, over: Partial<ForkView> = {}): ForkView => ({
  id, rootSessionId: "r", mode: "light", status: "idle", costUsd: null, costPartial: false, costApprox: false, startedAt, lastAt: startedAt,
  summarySentAt: null, conclusion: null, reaskOf: null, error: null, messages: [], ...over,
});
const report = (id: number, createdAt: number, reportKind: InboxItemView["reportKind"] = "done"): InboxItemView => ({
  id, kind: "report", sessionId: "s1", role: "ticket", ticketKey: null, featureId: null, repo: null,
  text: `r${id}`, options: [], context: null, reportKind, answer: null, createdAt, open: true, target: {} as never,
});
const input = (over: Partial<TimelineInput> = {}): TimelineInput => ({
  messages: [], refreshMarks: [], convHasMore: false, forks: [], reports: [], reportsHasMore: false, filter: "all", ...over,
});
const kinds = (items: { kind: string; key: string }[]) => items.map((i) => `${i.kind}`);

describe("buildTimeline", () => {
  it("orders messages and the refresh separator", () => {
    const out = buildTimeline(input({ messages: [msg(1, 10), msg(2, 20), msg(3, 40)], refreshMarks: [{ at: 30, sessionId: "s2" }] }));
    expect(kinds(out)).toEqual(["msg", "msg", "sep", "msg"]);
    expect(out[2]).toMatchObject({ kind: "sep", at: 30, sessionId: "s2" });
  });

  it("keeps fork messages out of the main stream and places the fork box by startedAt", () => {
    const out = buildTimeline(input({
      messages: [msg(1, 10), msg(2, 30), msg(9, 15, { forkId: 7 })],
      forks: [fork(7, 20)],
    }));
    expect(kinds(out)).toEqual(["msg", "fork", "msg"]);
    expect(out.some((i) => i.kind === "msg" && i.msg.id === 9)).toBe(false);
  });

  it("at the same time: messages, then forks and reports, then separators; keys are unique", () => {
    const out = buildTimeline(input({
      messages: [msg(1, 10)], forks: [fork(7, 10)], reports: [report(5, 10)], refreshMarks: [{ at: 10, sessionId: "s2" }],
    }));
    expect(kinds(out)).toEqual(["msg", "fork", "report", "sep"]);
    expect(new Set(out.map((i) => i.key)).size).toBe(out.length);
  });

  it("shows a fork that spans a refresh once, before the refresh", () => {
    const out = buildTimeline(input({
      messages: [msg(1, 5), msg(2, 50)], refreshMarks: [{ at: 30, sessionId: "s2" }], forks: [fork(7, 20, { lastAt: 40 })],
    }));
    expect(out.filter((i) => i.kind === "fork")).toHaveLength(1);
    expect(kinds(out)).toEqual(["msg", "fork", "sep", "msg"]);
  });

  it("brief case: only conversation has earlier pages; the cut is the earliest loaded message", () => {
    const out = buildTimeline(input({
      messages: [msg(1, 100), msg(2, 200)], convHasMore: true, reports: [report(1, 50), report(2, 150)], reportsHasMore: false,
      forks: [fork(3, 60)], refreshMarks: [{ at: 70, sessionId: "s0" }],
    }));
    expect(out.map((i) => i.key)).toEqual(["m1", "r2", "m2"]);
  });

  it("with both sides having more, the cut is the later of the two earliest times", () => {
    const out = buildTimeline(input({
      messages: [msg(1, 100), msg(2, 200)], convHasMore: true, reports: [report(1, 50), report(2, 150)], reportsHasMore: true,
    }));
    expect(out.map((i) => i.key)).toEqual(["m1", "r2", "m2"]);
  });

  it("only reports have more: the cut is the earliest loaded report", () => {
    const out = buildTimeline(input({ messages: [msg(1, 10), msg(2, 100)], reports: [report(1, 50)], reportsHasMore: true }));
    expect(out.map((i) => i.key)).toEqual(["r1", "m2"]);
  });

  it("both complete: everything shows", () => {
    expect(buildTimeline(input({ messages: [msg(1, 100)], reports: [report(1, 50)], forks: [fork(3, 60)] }))).toHaveLength(3);
  });

  it("interleaves done and blocked reports by createdAt", () => {
    const out = buildTimeline(input({ messages: [msg(1, 10), msg(2, 40)], reports: [report(1, 20, "done"), report(2, 30, "blocked")] }));
    expect(out.map((i) => i.key)).toEqual(["m1", "r1", "r2", "m2"]);
  });

  it("forks filter returns every fork, ignoring the cut", () => {
    const out = buildTimeline(input({
      filter: "forks", messages: [msg(1, 100)], convHasMore: true, reports: [report(1, 150)], reportsHasMore: true,
      forks: [fork(8, 90), fork(7, 10)],
    }));
    expect(out.map((i) => i.key)).toEqual(["f7", "f8"]);
  });
});

describe("costText", () => {
  const c = (costUsd: number | null, costPartial: boolean, status: ForkView["status"] = "idle", costApprox = false) => costText({ costUsd, costPartial, costApprox, status }, T);
  it("covers the brief's examples", () => {
    expect(c(null, false, "running")).toBe(T.conv.costPending);
    expect(c(null, true, "idle")).toBe(T.conv.costUnknown);
    expect(c(0.0312, true)).toBe("至少 $0.03");
    expect(c(0.004, false)).toBe("<$0.01");
    expect(c(0.004, true)).toBe("至少 $0.00");
    expect(c(1.2, false)).toBe("$1.20");
  });
  // 按份额拆的、按价格表估的：可能偏高也可能偏低，所以是「约」，不是「至少」。
  it("an approximate cost reads as an estimate, never as exact or as a lower bound", () => {
    expect(c(0.0312, false, "idle", true)).toBe("约 $0.03");
    expect(c(0.004, false, "idle", true)).toBe("约 <$0.01");
    expect(c(0.0312, true, "idle", true)).toBe("约 $0.03（不全）");
    const en = (p: boolean) => costText({ costUsd: 0.0312, costPartial: p, costApprox: true, status: "idle" }, STRINGS.en);
    expect(en(false)).toBe("≈ $0.03");
    expect(en(true)).toBe("≈ $0.03 (incomplete)");
  });
  it("never gives NaN or empty", () => {
    for (const [u, p, s] of [[null, false, "idle"], [null, true, "running"], [NaN, false, "idle"], [Infinity, true, "failed"], [0, false, "idle"], [-1, false, "idle"]] as const) {
      for (const t of [STRINGS.zh, STRINGS.en]) {
        const r = costText({ costUsd: u, costPartial: p, costApprox: p, status: s }, t);
        expect(r).not.toBe("");
        expect(r).not.toContain("NaN");
      }
    }
  });
});

describe("modeText", () => {
  it("names both modes", () => {
    expect(modeText("full", T)).toBe("完整上下文");
    expect(modeText("light", T)).toBe("精简上下文");
  });
});

describe("errorText", () => {
  const now = 1_700_000_000_000;
  it("mentions the reset time only when it is still ahead", () => {
    const later = errorText({ code: "rate_limited", resetAt: now + 3_600_000 }, T, now);
    const plain = errorText({ code: "rate_limited", resetAt: null }, T, now);
    const past = errorText({ code: "rate_limited", resetAt: now - 1 }, T, now);
    expect(later).toContain("恢复");
    expect(later).toContain(resetClock(now + 3_600_000, now));
    expect(plain).toBe("撞到用量限额了");
    expect(past).toBe(plain);
  });
  it("has a sentence for every code, in both languages", () => {
    const codes: ForkErrorCode[] = ["timeout", "spawn_failed", "exit_nonzero", "bad_output", "rate_limited", "claude_error", "model_unavailable", "aborted", "interrupted", "no_answer", "not_forked"];
    for (const t of [STRINGS.zh, STRINGS.en]) {
      const seen = new Map<string, ForkErrorCode>();
      for (const code of codes) {
        const s = errorText({ code, resetAt: null }, t, now);
        expect(s, code).not.toBe("");
        if (code !== "spawn_failed" && code !== "exit_nonzero" && code !== "bad_output" && code !== "claude_error" && code !== "aborted") seen.set(s, code);
      }
      expect(seen.size).toBe(6);
    }
  });
  it("not_forked is its own sentence, not the bad_output one", () => {
    expect(errorText({ code: "not_forked", resetAt: null }, T, now)).toBe("命令行没有分叉出新对话，这个讨论不能接着问了，请重新开一个");
    expect(errorText({ code: "not_forked", resetAt: null }, T, now)).not.toBe(errorText({ code: "bad_output", resetAt: null }, T, now));
  });
});

describe("sendBlockText / rememberText / refusalText", () => {
  it("covers every DevSendBlock", () => {
    const all: DevSendBlock[] = ["not_found", "failed", "in_flight", "fork_busy", "no_conclusion"];
    for (const t of [STRINGS.zh, STRINGS.en]) for (const r of all) expect(sendBlockText(r, t), r).not.toBe("");
  });

  it("queuedText: idle needs no note; busy and closed say when it arrives (BTL-248)", () => {
    expect(queuedText("idle", T)).toBeNull();
    for (const t of [STRINGS.zh, STRINGS.en]) for (const st of ["busy", "closed"] as const) expect(queuedText(st, t)).toBeTruthy();
    expect(queuedText("busy", T)).toContain("调用工具");
  });
  it("covers every RememberResult", () => {
    const all: RememberResult[] = ["written", "full", "disabled", "failed", "busy", "no_conclusion", "no_scope"];
    for (const t of [STRINGS.zh, STRINGS.en]) {
      const texts = all.map((r) => rememberText(r, t));
      expect(texts.every((x) => x !== "")).toBe(true);
      expect(new Set(texts).size).toBe(all.length);
    }
    expect(rememberText("no_scope", T)).toBe("这里的结论没有 ticket 或 epic 可记");
    expect(rememberText("no_scope", STRINGS.en)).toBe("There's no ticket or epic here to remember this under");
  });
  it("only disabled (memory off) turns the remember button off; no_scope (the Butler page) does not say memory is off", () => {
    expect(refusesMemory("disabled")).toBe(true);
    for (const r of ["no_scope", "written", "full", "failed", "busy", "no_conclusion"] as const) expect(refusesMemory(r), r).toBe(false);
  });
  it("covers every ForkRefusal, internal, and unknown codes", () => {
    const all: (ForkRefusal | "internal")[] = ["fork_busy", "dev_busy", "no_transcript", "no_claude", "not_found", "bad_question", "not_forked", "internal"];
    for (const t of [STRINGS.zh, STRINGS.en]) {
      const texts = all.map((c) => refusalText(c, t));
      expect(new Set(texts).size).toBe(all.length);
      expect(refusalText("weird", t)).toBe(t.conv.refusal.other);
      expect(refusalText("toString", t)).toBe(t.conv.refusal.other);
    }
    expect(refusalText("not_forked", T)).toContain("重新开一个");
  });
});

describe("turnBlocks", () => {
  const items = (list: Parameters<typeof buildTimeline>[0]) => buildTimeline(list);
  const ids = (b: ReturnType<typeof turnBlocks>) => b.map((x) => (x.kind === "turn" ? `t[${x.msgs.map((m) => m.id).join(",")}]` : x.item.key));
  it("merges consecutive same-turn assistant messages", () => {
    const b = turnBlocks(items(input({ messages: [msg(1, 1, { turnId: 5 }), msg(2, 2, { turnId: 5 }), msg(3, 3, { turnId: 6 })] })));
    expect(ids(b)).toEqual(["t[1,2]", "t[3]"]);
  });
  it("a fork box between same-turn messages breaks the run", () => {
    const b = turnBlocks(items(input({ messages: [msg(1, 1, { turnId: 5 }), msg(2, 3, { turnId: 5 })], forks: [fork(7, 2)] })));
    expect(ids(b)).toEqual(["t[1]", "f7", "t[2]"]);
  });
  it("reports, separators and user messages break a run", () => {
    const b = turnBlocks(items(input({
      messages: [msg(1, 1, { turnId: 5 }), msg(2, 3, { turnId: 5 }), msg(3, 5, { turnId: 5 }), msg(4, 6, { turnId: 5, role: "user" }), msg(5, 7, { turnId: 5 })],
      reports: [report(1, 2)], refreshMarks: [{ at: 4, sessionId: "s2" }],
    })));
    expect(ids(b)).toEqual(["t[1]", "r1", "t[2]", expect.stringMatching(/^s/), "t[3]", "m4", "t[5]"]);
  });
});

describe("mergeConvPage", () => {
  const page = (ids: number[], hasMore: boolean, marks: { at: number; sessionId: string }[] = []) =>
    ({ messages: ids.map((id) => msg(id, id * 10)), refreshMarks: marks, hasMore });
  it("the first page sets hasMore", () => {
    expect(mergeConvPage(null, page([1, 2], true), false)).toMatchObject({ hasMore: true });
  });
  it("an older page goes in front and decides hasMore; duplicates by id are dropped", () => {
    const cur = mergeConvPage(null, page([3, 4], true, [{ at: 35, sessionId: "s2" }]), false);
    const out = mergeConvPage(cur, page([1, 2, 3], false, [{ at: 15, sessionId: "s1" }, { at: 35, sessionId: "s2" }]), true);
    expect(out.messages.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(out.refreshMarks).toEqual([{ at: 15, sessionId: "s1" }, { at: 35, sessionId: "s2" }]);
    expect(out.hasMore).toBe(false);
  });
  it("re-reading the latest page keeps what is loaded, adds new ones, keeps hasMore, takes the newer copy of a message", () => {
    const cur = mergeConvPage(mergeConvPage(null, page([3, 4], true), false), page([1, 2], false), true);
    const latest = page([4, 5], true);
    latest.messages[0] = { ...latest.messages[0], text: "changed" };
    const out = mergeConvPage(cur, latest, false);
    expect(out.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    expect(out.messages[3].text).toBe("changed");
    expect(out.hasMore).toBe(false);
  });
  it("an older page that adds nothing new ends paging (the cursor vanished and the server sent the newest page again)", () => {
    const cur = mergeConvPage(null, page([3, 4], true), false);
    const out = mergeConvPage(cur, page([3, 4], true), true);
    expect(out.messages.map((m) => m.id)).toEqual([3, 4]);
    expect(out.hasMore).toBe(false);
    // 空的一页同样。
    expect(mergeConvPage(cur, page([], true), true).hasMore).toBe(false);
  });
});

describe("mergeReportPage", () => {
  it("orders by time, dedupes by id; older pages decide hasMore", () => {
    const cur = mergeReportPage(null, { reports: [report(3, 30), report(4, 40)], hasMore: true }, false);
    expect(cur.hasMore).toBe(true);
    const out = mergeReportPage(cur, { reports: [report(2, 20), report(3, 30)], hasMore: false }, true);
    expect(out.reports.map((r) => r.id)).toEqual([2, 3, 4]);
    expect(out.hasMore).toBe(false);
    const again = mergeReportPage(out, { reports: [report(4, 40), report(5, 50)], hasMore: true }, false);
    expect(again.reports.map((r) => r.id)).toEqual([2, 3, 4, 5]);
    expect(again.hasMore).toBe(false);
  });
  it("an older page that adds nothing new ends paging", () => {
    const cur = mergeReportPage(null, { reports: [report(3, 30), report(4, 40)], hasMore: true }, false);
    expect(mergeReportPage(cur, { reports: [report(4, 40), report(3, 30)], hasMore: true }, true).hasMore).toBe(false);
    expect(mergeReportPage(cur, { reports: [], hasMore: true }, true).hasMore).toBe(false);
  });
});

describe("lastQuestion", () => {
  it("is the last user message of the fork, or null", () => {
    const f = fork(7, 1, { messages: [msg(1, 1, { role: "user", text: "q1" }), msg(2, 2), msg(3, 3, { role: "user", text: "q2" }), msg(4, 4)] });
    expect(lastQuestion(f)).toBe("q2");
    expect(lastQuestion(fork(8, 1))).toBeNull();
  });
});

describe("draftCheck", () => {
  it("blank text cannot be sent", () => {
    for (const t of ["dev", "fork"] as const) expect(draftCheck(t, " \n ").blank).toBe(true);
    expect(draftCheck("dev", "hi")).toEqual({ blank: false, over: false, max: TASK_LIMIT });
  });
  it("dev: at most TASK_LIMIT characters, as IPC checks it", () => {
    expect(draftCheck("dev", "x".repeat(TASK_LIMIT)).over).toBe(false);
    expect(draftCheck("dev", "x".repeat(TASK_LIMIT + 1)).over).toBe(true);
  });
  it("fork: at most FORK_QUESTION_MAX characters after trimming, counting emoji as one (as IPC checks it)", () => {
    expect(draftCheck("fork", "x")).toEqual({ blank: false, over: false, max: FORK_QUESTION_MAX });
    expect(draftCheck("fork", "😀".repeat(FORK_QUESTION_MAX)).over).toBe(false);
    expect(draftCheck("fork", `  ${"x".repeat(FORK_QUESTION_MAX)}  `).over).toBe(false);
    expect(draftCheck("fork", "问".repeat(FORK_QUESTION_MAX + 1)).over).toBe(true);
  });
});

describe("keepSelection", () => {
  const sessions = [{ id: "r1" }, { id: "r2" }];
  it("keeps the current session while it is still listed, even if the default moved", () => {
    expect(keepSelection("r2", sessions, "r1")).toBe("r2");
  });
  it("falls back to the default when the current one is gone", () => {
    expect(keepSelection("gone", sessions, "r1")).toBe("r1");
  });
  it("an empty list does not move the selection", () => {
    expect(keepSelection("r2", [], "r1")).toBe("r2");
  });
});

describe("latestOnly", () => {
  it("only the newest started request counts", () => {
    const next = latestOnly();
    const a = next();
    const b = next();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
    next();
    expect(b()).toBe(false);
  });
});

describe("canRememberIn", () => {
  it("only a feature's control page has something to remember under; the Butler page doesn't", () => {
    expect(canRememberIn({ featureId: 3 })).toBe(true);
    expect(canRememberIn({ all: true })).toBe(false);
  });
});
