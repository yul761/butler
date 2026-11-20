import { describe, expect, it } from "vitest";
import type { ConvMessage } from "../../shared/conversation";
import type { DevSendBlock, ForkErrorCode, ForkRefusal, ForkView, RememberResult } from "../../shared/fork";
import type { InboxItemView } from "../../shared/types";
import { resetClock } from "./availability-view";
import { buildTimeline, costText, errorText, modeText, refusalText, rememberText, sendBlockText, turnBlocks, type TimelineInput } from "./conversation-view";
import { STRINGS } from "./strings";

const T = STRINGS.zh;

const msg = (id: number, at: number, over: Partial<ConvMessage> = {}): ConvMessage => ({
  id, rootSessionId: "r", sessionId: "s1", role: "assistant", text: `m${id}`, at, forkId: null, qa: true, turnId: id, ...over,
});
const fork = (id: number, startedAt: number, over: Partial<ForkView> = {}): ForkView => ({
  id, rootSessionId: "r", mode: "light", status: "idle", costUsd: null, costPartial: false, startedAt, lastAt: startedAt,
  summarySentAt: null, conclusion: null, reaskOf: null, error: null, messages: [], ...over,
});
const report = (id: number, createdAt: number, reportKind: InboxItemView["reportKind"] = "done"): InboxItemView => ({
  id, kind: "report", sessionId: "s1", role: "ticket", ticketKey: null, featureId: null, epicId: null, repo: null,
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
  const c = (costUsd: number | null, costPartial: boolean, status: ForkView["status"] = "idle") => costText({ costUsd, costPartial, status }, T);
  it("covers the brief's examples", () => {
    expect(c(null, false, "running")).toBe(T.conv.costPending);
    expect(c(null, true, "idle")).toBe(T.conv.costUnknown);
    expect(c(0.0312, true)).toBe("至少 $0.03");
    expect(c(0.004, false)).toBe("<$0.01");
    expect(c(0.004, true)).toBe("至少 $0.00");
    expect(c(1.2, false)).toBe("$1.20");
  });
  it("never gives NaN or empty", () => {
    for (const [u, p, s] of [[null, false, "idle"], [null, true, "running"], [NaN, false, "idle"], [Infinity, true, "failed"], [0, false, "idle"], [-1, false, "idle"]] as const) {
      for (const t of [STRINGS.zh, STRINGS.en]) {
        const r = costText({ costUsd: u, costPartial: p, status: s }, t);
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
    const all: DevSendBlock[] = ["closed", "hibernated", "busy", "screen", "needs_you", "typing", "draft", "cost_paused", "refreshing", "exited", "timeout", "blocked", "in_flight", "fork_busy", "no_conclusion", "not_found"];
    for (const t of [STRINGS.zh, STRINGS.en]) for (const r of all) expect(sendBlockText(r, t), r).not.toBe("");
    expect(sendBlockText("busy", T)).toContain("换新");
  });
  it("covers every RememberResult", () => {
    const all: RememberResult[] = ["written", "full", "disabled", "failed", "busy", "no_conclusion"];
    for (const t of [STRINGS.zh, STRINGS.en]) {
      const texts = all.map((r) => rememberText(r, t));
      expect(texts.every((x) => x !== "")).toBe(true);
      expect(new Set(texts).size).toBe(all.length);
    }
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
