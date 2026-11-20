import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TASK_LIMIT } from "../../../shared/control";
import type { ConvMessage } from "../../../shared/conversation";
import { FORK_QUESTION_MAX, type ForkView } from "../../../shared/fork";
import type { InboxItemView } from "../../../shared/types";
import { resetClock } from "../availability-view";
import { errorText, type TimelineItem } from "../conversation-view";
import { S } from "../strings";
import { ConversationFeed, ConversationTab, SearchHits, SendBar } from "./ConversationTab";
import { ForkBox, submitFollowUp, type ForkActions } from "./ForkBox";

const NOW = new Date(2026, 10, 20, 15, 0).getTime();
const AT = new Date(2026, 10, 20, 14, 32).getTime();
const noop = () => {};

const msg = (id: number, over: Partial<ConvMessage> = {}): ConvMessage => ({
  id, rootSessionId: "r", sessionId: "s1", role: "assistant", text: `m${id}`, at: AT + id, forkId: null, qa: true, turnId: id, ...over,
});
const fork = (over: Partial<ForkView> = {}): ForkView => ({
  id: 7, rootSessionId: "r", mode: "light", status: "idle", costUsd: null, costPartial: false, startedAt: AT, lastAt: AT,
  summarySentAt: null, conclusion: null, reaskOf: null, error: null,
  messages: [msg(20, { role: "user", text: "为什么？", forkId: 7, turnId: 0 }), msg(21, { text: "因为如此", forkId: 7, turnId: 0 })], ...over,
});
const report = (id: number): InboxItemView => ({
  id, kind: "report", sessionId: "s1", role: "ticket", ticketKey: "T-1", featureId: null, epicId: null, repo: null,
  text: `汇报${id}`, options: [], context: null, reportKind: "done", answer: null, createdAt: AT, open: true, target: {} as never,
});
const actions = (over: Partial<ForkActions> = {}): ForkActions => ({
  followUp: async () => true, sendConclusion: noop, remember: noop, reaskFull: noop, retry: noop, pending: {}, notice: {}, memoryOn: true, canRemember: true, ...over,
});
const box = (f: Partial<ForkView>, a: Partial<ForkActions> = {}) => renderToStaticMarkup(createElement(ForkBox, { fork: fork(f), actions: actions(a), now: NOW }));

/** 文字是 label 的那个按钮的开标签（含属性）。 */
const buttonTag = (html: string, label: string): string => {
  const at = html.indexOf(`>${label}</button>`);
  if (at < 0) throw new Error(`no button ${label}`);
  return html.slice(html.lastIndexOf("<button", at), at + 1);
};
const isDisabled = (html: string, label: string) => /\sdisabled=""/.test(buttonTag(html, label));

describe("ForkBox", () => {
  it("a running light fork: head, mode, cost pending; send / remember / follow-up disabled; can re-ask with full context", () => {
    const html = box({ status: "running" });
    expect(html).toContain('class="fork');
    expect(html).toContain(S.conv.forkHead);
    expect(S.conv.forkHead).toBe("讨论 · 从开发 session 分出来，只读，不影响它");
    expect(html).toContain("精简上下文");
    expect(html).toContain(S.conv.costPending);
    for (const label of ["按这个改 → 发给 session", "记进记忆", "接着问"]) expect(isDisabled(html, label)).toBe(true);
    expect(html).toContain(">用完整上下文重问</button>");
  });

  it("an idle full fork: mode and cost; no full-context re-ask; all three buttons enabled", () => {
    const html = box({ mode: "full", costUsd: 0.02 });
    expect(html).toContain("完整上下文");
    expect(html).toContain("$0.02");
    expect(html).not.toContain("用完整上下文重问");
    for (const label of ["按这个改 → 发给 session", "记进记忆", "接着问"]) expect(isDisabled(html, label)).toBe(false);
  });

  it("shows the questions and answers in the box", () => {
    const html = box({});
    expect(html).toContain("为什么？");
    expect(html).toContain("因为如此");
    expect(html.indexOf("为什么？")).toBeLessThan(html.indexOf("因为如此"));
  });

  it("a failed fork says why and offers to ask again", () => {
    const error = { code: "rate_limited" as const, resetAt: NOW + 3_600_000 };
    const html = box({ status: "failed", error });
    expect(html).toContain(errorText(error, S, NOW));
    expect(html).toContain(">再问一次</button>");
  });

  it("not_forked keeps its own sentence", () => {
    const html = box({ status: "failed", error: { code: "not_forked", resetAt: null } });
    expect(html).toContain(S.conv.error.not_forked);
    expect(html).not.toContain(S.conv.error.other);
  });

  it("after sending the conclusion: sent to session with the time", () => {
    expect(box({ summarySentAt: AT })).toContain(`已发给 session · ${resetClock(AT, NOW)}`);
  });

  it("while sending: that button is disabled and says sending", () => {
    const html = box({}, { pending: { 7: "send" } });
    expect(isDisabled(html, S.conv.sending)).toBe(true);
    expect(html).not.toContain(">按这个改 → 发给 session</button>");
  });

  it("shows the notice for this box", () => {
    expect(box({}, { notice: { 7: "你在终端里打了半句，先发完或清掉" } })).toContain("你在终端里打了半句，先发完或清掉");
  });

  it("memory off: save to memory is disabled", () => {
    expect(isDisabled(box({}, { memoryOn: false }), "记进记忆")).toBe(true);
  });

  it("no ticket or feature to remember under (Butler, epic pages): save to memory isn't shown at all", () => {
    expect(box({}, { canRemember: false })).not.toContain(S.conv.actRemember);
    expect(box({}, { canRemember: false })).toContain(S.conv.actSend);
    expect(box({}, { canRemember: true })).toContain(S.conv.actRemember);
  });
});

describe("ConversationFeed", () => {
  const feed = (items: TimelineItem[], hasOlder = false) =>
    renderToStaticMarkup(createElement(ConversationFeed, { items, hasOlder, onOlder: noop, actions: actions(), now: NOW }));

  it("renders every kind of item", () => {
    const html = feed([
      { kind: "msg", key: "m1", msg: msg(1, { role: "user", text: "改一下" }) },
      { kind: "msg", key: "m2", msg: msg(2, { text: "好的" }) },
      { kind: "sep", key: "s", at: AT, sessionId: "s2" },
      { kind: "fork", key: "f7", fork: fork() },
      { kind: "report", key: "r1", report: report(1) },
    ]);
    expect(html).toMatch(/class="msg-u">你：(<!-- -->)?改一下/);
    expect(html).toMatch(/class="msg-a"[^>]*>.*好的/);
    expect(html).toContain('class="sep"');
    expect(html).toContain(S.conv.refreshSep(resetClock(AT, NOW)));
    expect(html).toContain('class="fork');
    expect(html).toContain("inbox-report");
    expect(html).toContain(S.inboxReportKinds.done);
    expect(html).toContain("汇报1");
  });

  it("assistant messages of the same turn show as one block; fork messages are not merged into it", () => {
    const html = feed([
      { kind: "msg", key: "m1", msg: msg(1, { turnId: 5, text: "第一段" }) },
      { kind: "msg", key: "m2", msg: msg(2, { turnId: 5, text: "第二段" }) },
      { kind: "msg", key: "m3", msg: msg(3, { turnId: 6, text: "下一轮" }) },
    ]);
    expect(html.match(/class="msg-a"/g)).toHaveLength(2);
    expect(html).toMatch(/class="msg-a"[^>]*>(?:(?!class="msg-a").)*第一段(?:(?!class="msg-a").)*第二段/);
  });

  it("earlier button only when there are earlier pages", () => {
    expect(feed([{ kind: "msg", key: "m1", msg: msg(1) }], true)).toContain(`>${S.conv.older}</button>`);
    expect(feed([{ kind: "msg", key: "m1", msg: msg(1) }], false)).not.toContain(S.conv.older);
  });

  it("empty", () => {
    expect(feed([])).toContain(S.conv.empty);
  });

  it("a report-only feed (control conversation) lists the reports in the given order", () => {
    const html = feed([{ kind: "report", key: "r1", report: report(1) }, { kind: "report", key: "r2", report: report(2) }]);
    expect(html.indexOf("汇报1")).toBeLessThan(html.indexOf("汇报2"));
    expect(html).not.toContain(S.conv.empty);
  });
});

describe("SendBar", () => {
  const bar = (o: Partial<Parameters<typeof SendBar>[0]> = {}) =>
    renderToStaticMarkup(createElement(SendBar, { target: "fork", onTarget: noop, busy: false, notice: null, draft: "问一句", onDraft: noop, onSend: noop, ...o }));

  it("ask-only is selected when the target is fork", () => {
    const html = bar();
    expect(html).toMatch(/aria-checked="true"[^>]*>只问不改（分叉讨论）</);
    expect(html).toMatch(/aria-checked="false"[^>]*>开发 session</);
    expect(bar({ target: "dev" })).toMatch(/aria-checked="true"[^>]*>开发 session</);
  });

  it("shows the notice", () => {
    expect(bar({ notice: "你在终端里打了半句，先发完或清掉" })).toContain("你在终端里打了半句，先发完或清掉");
  });

  it("send is disabled while busy and for blank text", () => {
    expect(isDisabled(bar(), S.conv.send)).toBe(false);
    expect(isDisabled(bar({ busy: true }), S.conv.send)).toBe(true);
    expect(isDisabled(bar({ draft: "  \n " }), S.conv.send)).toBe(true);
  });

  it("too long: send is disabled and the limit is shown (dev: TASK_LIMIT, fork: FORK_QUESTION_MAX)", () => {
    expect(isDisabled(bar({ target: "dev", draft: "x".repeat(TASK_LIMIT) }), S.conv.send)).toBe(false);
    const dev = bar({ target: "dev", draft: "x".repeat(TASK_LIMIT + 1) });
    expect(isDisabled(dev, S.conv.send)).toBe(true);
    expect(dev).toContain(S.conv.tooLong(TASK_LIMIT));
    expect(isDisabled(bar({ draft: "问".repeat(FORK_QUESTION_MAX) }), S.conv.send)).toBe(false);
    const ask = bar({ draft: "问".repeat(FORK_QUESTION_MAX + 1) });
    expect(isDisabled(ask, S.conv.send)).toBe(true);
    expect(ask).toContain(S.conv.tooLong(FORK_QUESTION_MAX));
  });
});

describe("submitFollowUp", () => {
  it("clears and closes the follow-up input only when the question went out", async () => {
    const clear = vi.fn();
    await submitFollowUp(async () => false, 7, "  再问  ", clear);
    expect(clear).not.toHaveBeenCalled();
    const sent = vi.fn(async () => true);
    await submitFollowUp(sent, 7, "  再问  ", clear);
    expect(sent).toHaveBeenCalledWith(7, "再问");
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("SearchHits", () => {
  const hits = (h: ConvMessage[] | null) => renderToStaticMarkup(createElement(SearchHits, { hits: h }));

  it("nothing searched yet: nothing", () => {
    expect(hits(null)).toBe("");
  });

  it("no matches", () => {
    expect(hits([])).toContain(S.conv.noMatch);
  });

  it("flat results; the fork message carries the fork tag, the user one says 你：", () => {
    const html = hits([msg(1, { role: "user", text: "主流问" }), msg(2, { text: "分叉答", forkId: 7 })]);
    expect(html).toMatch(/class="msg-u">(<!-- -->)?你：(<!-- -->)?主流问/);
    expect(html).toMatch(/class="msg-a"><span class="fork-tag">讨论<\/span>分叉答/);
    expect(html.match(/fork-tag/g)).toHaveLength(1);
  });
});

describe("ConversationTab", () => {
  it("the footer (Butler replies) sits above the send bar", () => {
    const html = renderToStaticMarkup(createElement(ConversationTab, { rootSessionId: "r", sessions: [], footer: createElement("div", { className: "the-footer" }) }));
    expect(html).toContain("the-footer");
    expect(html.indexOf("the-footer")).toBeLessThan(html.indexOf("conv-input"));
  });
});
