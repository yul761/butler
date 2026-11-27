import { describe, expect, it, vi } from "vitest";
import { M } from "../strings";
import type { Session, Ticket } from "../../shared/types";
import { InboxRepo } from "../db/inbox-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { memDb } from "../test-utils";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMessagesRepo } from "../db/session-messages-repo";
import { Mailbox } from "../mailbox/mailbox";
import { TASK_LIMIT } from "../../shared/control";
import type { RecordEvent } from "../metrics/events";
import { AutoChoicesRepo, ChoiceDefaultsRepo } from "../db/interrupts-repo";
import { ChoiceService } from "../interrupts/choices";
import { ANSWERING_TTL_MS, InboxService, REPORT_DELIVERY_MAX_AGE_MS, roleOf, type AskedQuestion, type InboxServiceDeps } from "./inbox-service";

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id, ticketKey: null, cwd: "/w", origin: "shipherd", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: true, replacedBy: null,
  dismissed: false, createdAt: 1, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, shipherd: false, lessonRunId: null, ...o,
});

const ticket = (key: string, featureId: number | null, repos: { id: number; repoPath: string }[] = [{ id: 1, repoPath: "/r/api" }]): Ticket =>
  ({ key, featureId, repos, title: null } as unknown as Ticket);

/** 链：chains 里 old → new 的映射，head 沿着走到底。 */
function setup(o: {
  sessions: Session[]; tickets?: Ticket[]; open?: string[]; recordEvent?: RecordEvent;
  onAsked?: (q: AskedQuestion) => void; choices?: InboxServiceDeps["choices"]; latestCoordinator?: InboxServiceDeps["latestCoordinator"];
}) {
  const repo = new InboxRepo(memDb());
  const sessions = new Map(o.sessions.map((s) => [s.id, s]));
  const replaced = new Map<string, string>();
  const tickets = new Map((o.tickets ?? []).map((t) => [t.key, t]));
  const state = {
    now: 1_000,
    open: new Set(o.open ?? o.sessions.map((s) => s.id)),
    answerGate: null as DeliveryCheck | null,
    reportGate: null as DeliveryCheck | null,
    result: "sent" as DeliverResult,
    /** 正在换新的 session（head id）。 */
    refreshing: new Set<string>(),
  };
  const head = (id: string): Session | null => {
    let cur = id;
    while (replaced.has(cur)) cur = replaced.get(cur)!;
    return sessions.get(cur) ?? null;
  };
  const gate = (which: "answerGate" | "reportGate") => ({
    check: (id: string): DeliveryCheck => state[which] ?? { ok: true, termId: `term-${head(id)?.id ?? id}`, headId: head(id)?.id ?? id },
    recheckAfter: () => () => true,
  });
  const notify = vi.fn();
  const deliver = vi.fn<(term: string, text: string, recheck: () => boolean) => Promise<DeliverResult>>(async () => state.result);
  const termOf = (id: string) => (state.open.has(head(id)?.id ?? id) ? `term-${head(id)?.id ?? id}` : null);
  // 真的信箱（BTL-245），终端 id 是 term-<head>：回答和汇报都经它送。
  let inboxRef: InboxService | null = null;
  const mailbox = new Mailbox({
    repo: new SessionMessagesRepo(memDb()), root: mkdtempSync(join(tmpdir(), "inbox-mb-")),
    head: (id) => head(id.startsWith("term-") ? id.slice(5) : id), termOf, openTerms: () => [...state.open].map((id) => `term-${id}`),
    check: (id, g) => gate(g.answer ? "answerGate" : "reportGate").check(id), recheckAfter: () => () => true,
    deliver: (t, text, recheck) => deliver(t, text, recheck),
    canInterrupt: () => false, interrupt: () => {}, interruptRecheck: () => () => true,
    lastReply: () => null, nameOf: (id) => id ?? "Shipherd", typing: (h, phase) => inboxRef?.shipherdTyping(h, phase),
    // 和 index.ts 一样接上（BTL-269 A2）：coord 是总控，它在等的是还没答的 ask_user。
    fromController: (m) => m.fromSession === "coord",
    awaitingUser: (h) => ({ asks: inboxRef?.unansweredAsks(h) ?? [], text: null }),
    coordinatorAnswered: (h, x) => inboxRef?.coordinatorAnswered(h, x),
    notify: () => {}, now: () => state.now, log: () => {},
  });
  const inbox = new InboxService({
    repo, head, ticket: (k) => tickets.get(k) ?? null,
    termOf,
    openHeads: () => [...state.open].map((id) => sessions.get(id)!).filter(Boolean),
    refreshing: (id) => state.refreshing.has(head(id)?.id ?? id),
    mailbox, latestCoordinator: o.latestCoordinator, notify, now: () => state.now, log: () => {},
    recordEvent: o.recordEvent, onAsked: o.onAsked, choices: o.choices,
  });
  inboxRef = inbox;
  const replace = (from: string, to: Session) => {
    sessions.set(to.id, to);
    replaced.set(from, to.id);
    if (state.open.delete(from)) state.open.add(to.id);
  };
  // 测试里的 flush = 补排 + 信箱的一次 tick（调度器里两个都每个 tick 跑）。
  const backfill = inbox.flush.bind(inbox);
  inbox.flush = async () => {
    await backfill();
    await mailbox.tick();
    await settle();
  };
  return { repo, inbox, state, deliver, notify, replace, sessions, mailbox };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("InboxService ask_user (BTL-190 2+3)", () => {
  it("records a decision with its ticket and feature, and supersedes the same pending question of the same session", () => {
    const s = session("s1", { ticketKey: "BTL-1", repoId: 1 });
    const { inbox, repo, notify } = setup({ sessions: [s], tickets: [ticket("BTL-1", 3)] });
    const a = inbox.ask(s, { question: "Which?", options: ["A", "B"], context: "ctx" });
    expect(repo.get(a)).toMatchObject({ sessionId: "s1", ticketKey: "BTL-1", featureId: 3, options: ["A", "B"], context: "ctx", status: "pending" });
    const other = inbox.ask(s, { question: "Another?" });
    const b = inbox.ask(s, { question: "Which?" });
    expect(repo.get(a)?.status).toBe("superseded");
    expect(repo.pendingDecisions().map((x) => x.id)).toEqual([other, b]);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(inbox.hasPendingDecision("s1")).toBe(true);
  });

  it("a feature coordinator owns its feature", () => {
    const fc = session("fc", { featureId: 3 });
    const { inbox, repo } = setup({ sessions: [fc] });
    expect(repo.get(inbox.ask(fc, { question: "q" }))).toMatchObject({ ticketKey: null, featureId: 3 });
  });

  it("delivers a card answer into the asking session as one message, then marks it answered", async () => {
    const s = session("s1", { ticketKey: "BTL-1" });
    const { inbox, repo, deliver } = setup({ sessions: [s], tickets: [ticket("BTL-1", null)] });
    const id = inbox.ask(s, { question: "用哪个方案？", options: ["A", "B"] });
    expect(inbox.answer(id, "  B ")).toBe(true);
    await settle();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe("term-s1");
    expect(deliver.mock.calls[0][1]).toContain("---\n\n你问的『用哪个方案？』，用户的回答：B");
    expect(repo.get(id)).toMatchObject({ status: "answered", answer: "B" });
    expect(inbox.hasPendingDecision("s1")).toBe(false);
    // 已经答过的、空的回答、不存在的条目都不接。
    expect(inbox.answer(id, "A")).toBe(false);
    expect(inbox.answer(inbox.ask(s, { question: "q" }), "   ")).toBe(false);
    expect(inbox.answer(999, "x")).toBe(false);
  });

  it("keeps the answer queued while the session cannot take input, and delivers it on a later flush, to the new head after a refresh", async () => {
    const s = session("s1", { ticketKey: "BTL-1" });
    const { inbox, repo, deliver, state, replace } = setup({ sessions: [s] });
    const id = inbox.ask(s, { question: "q1" });
    const id2 = inbox.ask(s, { question: "q2" });
    state.answerGate = { ok: false, block: "busy" };
    inbox.answer(id, "yes");
    inbox.answer(id2, "no");
    await settle();
    expect(deliver).not.toHaveBeenCalled();
    expect(repo.get(id)).toMatchObject({ status: "pending", answer: "yes" });
    expect(inbox.pendingDecisionViews()[0]).toMatchObject({ answer: "yes" });
    // 不能送的时候 deliver 也没送到（比如 recheck 不过）：留着。
    state.answerGate = null;
    state.result = "blocked";
    await inbox.flush();
    expect(repo.get(id)?.status).toBe("pending");
    replace("s1", session("s2", { ticketKey: "BTL-1" }));
    state.result = "sent";
    deliver.mockClear();
    await inbox.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe("term-s2");
    const text = deliver.mock.calls[0][1];
    expect(text).toContain("『q1』，用户的回答：yes");
    expect(text).toContain("『q2』，用户的回答：no");
    expect(repo.pendingDecisions()).toEqual([]);
  });

  it("a UserPromptSubmit in the asking session (any id on its chain) answers its unanswered items, but not other sessions'", async () => {
    const s = session("s1");
    const t = session("t1");
    const { inbox, repo, replace, state, deliver } = setup({ sessions: [s, t] });
    const a = inbox.ask(s, { question: "a" });
    const b = inbox.ask(s, { question: "b" });
    state.answerGate = { ok: false, block: "typing" };
    inbox.answer(b, "queued");
    const c = inbox.ask(t, { question: "c" });
    replace("s1", session("s2"));
    inbox.promptSubmitted("s1");
    expect(repo.get(a)?.status).toBe("answered");
    // 卡片上答好、还没送进去的留着：下次停下来照常送。
    expect(repo.get(b)).toMatchObject({ status: "pending", answer: "queued" });
    expect(repo.get(c)?.status).toBe("pending");
    expect(inbox.hasPendingDecision("t1")).toBe(true);
    state.answerGate = null;
    await inbox.flush();
    expect(deliver.mock.calls.at(-1)?.[1]).toContain("『b』，用户的回答：queued");
    expect(repo.get(b)?.status).toBe("answered");
    expect(inbox.hasPendingDecision("s2")).toBe(false);
  });

  it("marks only the named questions of that session, asked before the message was queued, as answered by its coordinator (BTL-269 A2)", () => {
    const s = session("s1");
    const t = session("t1");
    const { inbox, repo, replace, state } = setup({ sessions: [s, t] });
    const a = inbox.ask(s, { question: "a" });
    const b = inbox.ask(s, { question: "b" });
    state.answerGate = { ok: false, block: "typing" };
    inbox.answer(b, "from the card");
    const c = inbox.ask(t, { question: "c" });
    state.now = 2_000;
    const late = inbox.ask(s, { question: "asked after the message" });
    replace("s1", session("s2"));
    expect(inbox.unansweredAsks("s2").map((x) => x.id)).toEqual([a, late]);
    // c 是别的 session 的，b 卡片上答过了，late 是那条消息排进来之后才问的：都不动。
    inbox.coordinatorAnswered("s2", { asks: [a, b, c, late], answer: "go with A", by: "the coordinator", queuedAt: 1_500 });
    expect(repo.get(a)).toMatchObject({ status: "answered", answer: "go with A", behalfBy: "the coordinator", behalfSeenAt: null });
    expect(repo.get(b)).toMatchObject({ status: "pending", answer: "from the card", behalfBy: null });
    expect(repo.get(c)?.status).toBe("pending");
    expect(repo.get(late)?.status).toBe("pending");
    expect(inbox.hasPendingDecision("t1")).toBe(true);
  });

  it("shows an 'answered by the coordinator' notice with the answer; a change goes in as a correction and the notice goes away (BTL-269 A2)", async () => {
    const s = session("s1", { ticketKey: "BTL-1" });
    const { inbox, repo, deliver } = setup({ sessions: [s], tickets: [ticket("BTL-1", 3)] });
    const a = inbox.ask(s, { question: "A or B?" });
    inbox.coordinatorAnswered("s1", { asks: [a], answer: "A", by: "the coordinator", queuedAt: 5_000 });
    const [n] = inbox.behalfNotices(() => "Login");
    expect(n).toMatchObject({ kind: "behalf_answered", askId: a, question: "A or B?", answer: "A", by: "the coordinator", title: "Login", target: { page: "ticket", key: "BTL-1", sessionId: "s1" } });
    // 卡片已经不算未决：不再挡别的自动输入。
    expect(inbox.hasPendingDecision("s1")).toBe(false);
    expect(inbox.correctBehalf(a, "  B, actually ")).toBe(true);
    await settle();
    const text = deliver.mock.calls.at(-1)![1];
    expect(text).toContain(M().inboxCorrection("A or B?", "A", "B, actually"));
    expect(inbox.behalfNotices(() => null)).toEqual([]);
    expect(repo.get(a)?.behalfSeenAt).not.toBeNull();
    // 更正的送达不会把条目改回别的状态。
    expect(repo.get(a)).toMatchObject({ status: "answered", answer: "A" });
  });

  it("end to end: a coordinator message without answers leaves the card alone; with answers it closes the card with the coordinator's words (BTL-269 A2)", async () => {
    const s = session("s1");
    const { inbox, repo, deliver, state, mailbox } = setup({ sessions: [s, session("coord")] });
    const a = inbox.ask(s, { question: "A or B?" });
    state.reportGate = { ok: false, block: "needs_you" };
    state.now = 2_000;
    mailbox.send({ kind: "instruction", from: "coord", to: "s1", featureId: null, body: "FYI the API changed" });
    await inbox.flush();
    expect(deliver.mock.calls.at(-1)![1]).toContain(M().mailboxNotAnAnswer);
    expect(repo.get(a)).toMatchObject({ status: "pending", answer: null });
    mailbox.send({ kind: "instruction", from: "coord", to: "s1", featureId: null, body: "[from coord] B", meta: { answers: a, text: "B" } });
    await inbox.flush();
    expect(deliver.mock.calls.at(-1)![1]).toContain(M().mailboxAnswersQuestion("A or B?"));
    expect(repo.get(a)).toMatchObject({ status: "answered", answer: "B", behalfBy: "coord" });
    expect(inbox.behalfNotices(() => null).map((n) => n.askId)).toEqual([a]);
  });

  it("dismissing the notice keeps the coordinator's answer; questions the user answered get no notice and cannot be corrected this way (BTL-269 A2)", () => {
    const s = session("s1");
    const { inbox, repo } = setup({ sessions: [s] });
    const a = inbox.ask(s, { question: "a" });
    const b = inbox.ask(s, { question: "b" });
    inbox.coordinatorAnswered("s1", { asks: [a], answer: "x", by: "c", queuedAt: 5_000 });
    inbox.promptSubmitted("s1");
    expect(repo.get(b)?.status).toBe("answered");
    expect(inbox.behalfNotices(() => null).map((n) => n.askId)).toEqual([a]);
    expect(inbox.correctBehalf(b, "y")).toBe(false);
    expect(inbox.dismissBehalf(a)).toBe(true);
    expect(inbox.dismissBehalf(a)).toBe(false);
    expect(inbox.behalfNotices(() => null)).toEqual([]);
    expect(repo.get(a)).toMatchObject({ status: "answered", answer: "x" });
  });

  it("ignores the UserPromptSubmit of Shipherd's own /handoff and resume message while the session is being refreshed", () => {
    const s = session("s1");
    const { inbox, repo, state, replace } = setup({ sessions: [s] });
    const a = inbox.ask(s, { question: "a" });
    state.refreshing.add("s1");
    inbox.promptSubmitted("s1");
    // /clear 之后 head 换了：按链认。
    replace("s1", session("s2"));
    state.refreshing = new Set(["s2"]);
    inbox.promptSubmitted("s1");
    inbox.promptSubmitted("s2");
    expect(repo.get(a)?.status).toBe("pending");
    state.refreshing.clear();
    inbox.promptSubmitted("s2");
    expect(repo.get(a)?.status).toBe("answered");
  });

  it("a late UserPromptSubmit of a delivered answer does not end the session's other items; one past the window does", async () => {
    const s = session("s1");
    const { inbox, repo, state } = setup({ sessions: [s] });
    const a = inbox.ask(s, { question: "a" });
    const b = inbox.ask(s, { question: "b" });
    // deliver 没等到 UserPromptSubmit 就返回了 sent（hook 还没到）。
    inbox.answer(a, "ok");
    await settle();
    expect(repo.get(a)?.status).toBe("answered");
    state.now += 5_000;
    inbox.promptSubmitted("s1");
    expect(repo.get(b)?.status).toBe("pending");
    // 只认一次：再来的是用户自己在终端里回答。
    inbox.promptSubmitted("s1");
    expect(repo.get(b)?.status).toBe("answered");

    const c = inbox.ask(s, { question: "c" });
    const d = inbox.ask(s, { question: "d" });
    inbox.answer(c, "ok");
    await settle();
    state.now += ANSWERING_TTL_MS + 1;
    inbox.promptSubmitted("s1");
    expect(repo.get(d)?.status).toBe("answered");
  });

  it("a delivery that typed nothing leaves no window behind", async () => {
    const s = session("s1");
    const { inbox, repo, state } = setup({ sessions: [s] });
    const a = inbox.ask(s, { question: "a" });
    const b = inbox.ask(s, { question: "b" });
    state.result = "blocked";
    inbox.answer(a, "ok");
    await settle();
    inbox.promptSubmitted("s1");
    expect(repo.get(b)?.status).toBe("answered");
    expect(repo.get(a)).toMatchObject({ status: "pending", answer: "ok" });
  });

  it("an answer changed on the card while it is being delivered stays pending with the new answer and is sent next", async () => {
    const s = session("s1");
    const { inbox, repo, deliver } = setup({ sessions: [s] });
    const a = inbox.ask(s, { question: "a" });
    deliver.mockImplementationOnce(async () => {
      expect(inbox.answer(a, "second")).toBe(true);
      return "sent";
    });
    inbox.answer(a, "first");
    await settle();
    expect(repo.get(a)).toMatchObject({ status: "pending", answer: "second" });
    await inbox.flush();
    expect(deliver.mock.calls.at(-1)?.[1]).toContain("用户的回答：second");
    expect(repo.get(a)?.status).toBe("answered");
  });

  it("splits answers that do not fit in one message, and cuts a single answer that is too long by itself", async () => {
    const s = session("s1");
    const { inbox, repo, deliver, state } = setup({ sessions: [s] });
    const ids = ["q1", "q2", "q3"].map((q) => inbox.ask(s, { question: q }));
    state.answerGate = { ok: false, block: "busy" };
    for (const id of ids) inbox.answer(id, "x".repeat(3000));
    state.answerGate = null;
    await inbox.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    const first = deliver.mock.calls[0][1];
    expect(first).toContain("『q1』");
    expect(first).toContain("『q2』");
    expect(first).not.toContain("『q3』");
    expect(ids.map((id) => repo.get(id)?.status)).toEqual(["answered", "answered", "pending"]);
    await inbox.flush();
    expect(deliver.mock.calls[1][1]).toContain("『q3』");
    expect(repo.get(ids[2])?.status).toBe("answered");

    const long = inbox.ask(s, { question: "long" });
    inbox.answer(long, `${"y".repeat(9000)}END`);
    await settle();
    const text = deliver.mock.calls[2][1];
    expect(text.length).toBeLessThanOrEqual(TASK_LIMIT);
    expect(text).toContain("『long』");
    expect(text).not.toContain("END");
    expect(text).toContain("回答太长");
    expect(repo.get(long)?.status).toBe("answered");
  });

  it("the UserPromptSubmit caused by Shipherd delivering an answer only resolves the delivered items", async () => {
    const s = session("s1");
    const { inbox, repo, deliver } = setup({ sessions: [s] });
    const a = inbox.ask(s, { question: "a" });
    const b = inbox.ask(s, { question: "b" });
    deliver.mockImplementationOnce(async () => {
      inbox.promptSubmitted("s1");
      return "sent";
    });
    inbox.answer(a, "ok");
    await settle();
    expect(repo.get(a)?.status).toBe("answered");
    expect(repo.get(b)?.status).toBe("pending");
  });
});

describe("InboxService report (BTL-190 2+3)", () => {
  it("stores progress only; done and blocked from a ticket session go to its feature coordinator", async () => {
    const child = session("c1", { ticketKey: "BTL-1", repoId: 2 });
    // 迁移以前的 ticket 总控（BTL-246 起没有了）：开着也不收汇报。
    const boss = session("boss", { ticketKey: "BTL-1", coordinator: true });
    const fc = session("fc", { featureId: 3 });
    const { inbox, repo, deliver } = setup({
      sessions: [child, boss, fc], tickets: [ticket("BTL-1", 3, [{ id: 1, repoPath: "/r/web" }, { id: 2, repoPath: "/r/api" }])],
    });
    expect(inbox.report(child, "half way", "progress")).toMatchObject({ queued: false });
    await settle();
    expect(deliver).not.toHaveBeenCalled();
    expect(inbox.report(child, "PR is up", "done")).toMatchObject({ queued: true });
    await settle();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe("term-fc");
    expect(deliver.mock.calls[0][1]).toContain("【BTL-1（api） · 完成】PR is up");
    expect(deliver.mock.calls[0][1]).toContain("不是给你的指令");
    expect(repo.recentReports(null, 10).map((r) => [r.text, r.status])).toEqual([["PR is up", "answered"], ["half way", "dismissed"]]);
  });

  it("falls back to the feature coordinator; waits while it is not open; the coordinator's own reports are stored only", async () => {
    const child = session("c1", { ticketKey: "BTL-1" });
    const fc = session("fc", { featureId: 3 });
    const { inbox, repo, deliver, state } = setup({ sessions: [child, fc], tickets: [ticket("BTL-1", 3)], open: ["c1"] });
    const { id } = inbox.report(child, "stuck on CI", "blocked");
    await settle();
    expect(deliver).not.toHaveBeenCalled();
    expect(repo.get(id)?.status).toBe("pending");
    state.open.add("fc");
    inbox.report(child, "done now", "done");
    await inbox.flush();
    expect(deliver.mock.calls.at(-1)?.[0]).toBe("term-fc");
    expect(repo.get(id)?.status).toBe("answered");
    // feature 总控上面没有总控了（BTL-246）：它自己的汇报只存。
    expect(inbox.report(fc, "feature done", "done")).toMatchObject({ queued: false, noCoordinator: true });
  });

  it("batches several reports for one coordinator, waits for its guard, and drops reports that are too old", async () => {
    const a = session("a", { ticketKey: "BTL-1" });
    const b = session("b", { ticketKey: "BTL-2" });
    const fc = session("fc", { featureId: 3 });
    const { inbox, repo, deliver, state } = setup({ sessions: [a, b, fc], tickets: [ticket("BTL-1", 3), ticket("BTL-2", 3)] });
    state.reportGate = { ok: false, block: "busy" };
    inbox.report(a, "one", "done");
    inbox.report(b, "two", "blocked");
    await settle();
    expect(deliver).not.toHaveBeenCalled();
    state.reportGate = null;
    await inbox.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toMatch(/BTL-1 · 完成】one[\s\S]*BTL-2 · 卡住】two/);
    expect(repo.pendingReports()).toEqual([]);

    // 排进了信箱的不过期：总控忙了很久，停下来照样送到，注明是多久之前发的。
    state.reportGate = { ok: false, block: "needs_you" };
    const late = inbox.report(a, "late", "done");
    state.now += REPORT_DELIVERY_MAX_AGE_MS + 1;
    state.reportGate = null;
    await inbox.flush();
    expect(repo.get(late.id)?.status).toBe("answered");
    expect(deliver.mock.calls.at(-1)?.[1]).toMatch(/分钟前发的[\s\S]*late/);

    // 一个总控都找不到的汇报，过了 6 小时就不送了。
    state.open.delete("fc");
    const old = inbox.report(a, "stale", "done");
    state.now += REPORT_DELIVERY_MAX_AGE_MS + 1;
    await inbox.flush();
    expect(repo.get(old.id)?.status).toBe("dismissed");
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("queues a report for the latest coordinator when none is open; it reads it when its terminal opens (BTL-245)", async () => {
    const a = session("a", { ticketKey: "BTL-1" });
    const fc = session("fc", { featureId: 3 });
    const { inbox, repo, deliver, state, mailbox } = setup({
      sessions: [a, fc], tickets: [ticket("BTL-1", 3)], open: ["a"], latestCoordinator: (w) => ("feature" in w && w.feature === 3 ? "fc" : null),
    });
    const r = inbox.report(a, "PR up", "done");
    await inbox.flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(mailbox.queuedByRef(`report:${r.id}`)?.toSession).toBe("fc");
    state.open.add("fc");
    await mailbox.stopped("fc");
    expect(deliver.mock.calls.at(-1)?.[0]).toBe("term-fc");
    expect(repo.get(r.id)?.status).toBe("answered");
  });
});

describe("InboxService withdrawals (BTL-245)", () => {
  it("withdraws a queued report or answer once its item is dismissed by archiving", async () => {
    const a = session("a", { ticketKey: "BTL-1" });
    const fc = session("fc", { featureId: 3 });
    const { inbox, repo, mailbox, state } = setup({ sessions: [a, fc], tickets: [ticket("BTL-1", 3)], open: ["a", "fc"] });
    state.answerGate = { ok: false, block: "busy" };
    state.reportGate = { ok: false, block: "busy" };
    const r = inbox.report(a, "PR up", "done");
    const q = inbox.ask(a, { question: "which?" });
    inbox.answer(q, "this one");
    await settle();
    expect(mailbox.queuedByRef(`report:${r.id}`)).not.toBeNull();
    expect(mailbox.queuedByRef(`answer:${q}`)).not.toBeNull();
    inbox.dismissScope({ ticketKey: "BTL-1" });
    expect(mailbox.queuedByRef(`report:${r.id}`)).toBeNull();
    expect(mailbox.queuedByRef(`answer:${q}`)).toBeNull();
    expect(repo.get(r.id)?.status).toBe("dismissed");
  });
});

describe("InboxService report without a coordinator above (BTL-190 2+3)", () => {
  it("only queues done / blocked when a coordinator could manage the session", () => {
    // 不属于 feature 的 ticket：ticket 总控没有了（BTL-246），上面不会有总控。
    const lone = session("t1", { ticketKey: "BTL-1" });
    const inFeature = session("t2", { ticketKey: "BTL-2" });
    const fcAlone = session("fc1", { featureId: 3 });
    const fix = session("fx", { featureId: 3, fixesSession: "t1" });
    const { inbox, repo } = setup({
      sessions: [lone, inFeature, fcAlone, fix], tickets: [ticket("BTL-1", null), ticket("BTL-2", 3)], open: [],
    });
    const r1 = inbox.report(lone, "done", "done");
    expect(r1).toMatchObject({ queued: false, noCoordinator: true });
    expect(repo.get(r1.id)?.status).toBe("dismissed");
    expect(inbox.report(fcAlone, "done", "blocked")).toMatchObject({ queued: false, noCoordinator: true });
    expect(inbox.report(inFeature, "done", "done")).toMatchObject({ queued: true, noCoordinator: false });
    expect(inbox.report(fix, "done", "done")).toMatchObject({ queued: true, noCoordinator: false });
    // progress 本来就只存，不算「上面没有总控」。
    expect(inbox.report(lone, "half", "progress")).toMatchObject({ queued: false, noCoordinator: false });
  });
});

describe("InboxService archiving (BTL-190 2+3)", () => {
  it("dismisses the pending decisions and reports of an archived ticket or feature", () => {
    const t1 = session("t1", { ticketKey: "BTL-1" });
    const t2 = session("t2", { ticketKey: "BTL-2" });
    const fc = session("fc", { featureId: 4 });
    const { inbox, repo, notify } = setup({ sessions: [t1, t2, fc], tickets: [ticket("BTL-1", 3), ticket("BTL-2", 4)], open: [] });
    const a = inbox.ask(t1, { question: "a" });
    const ra = inbox.report(t1, "r", "done").id;
    const b = inbox.ask(t2, { question: "b" });
    const c = inbox.ask(fc, { question: "c" });
    notify.mockClear();
    inbox.dismissScope({ ticketKey: "BTL-1" });
    expect([repo.get(a)?.status, repo.get(ra)?.status, repo.get(b)?.status]).toEqual(["dismissed", "dismissed", "pending"]);
    expect(notify).toHaveBeenCalledTimes(1);
    inbox.dismissScope({ featureId: 4 });
    expect([repo.get(b)?.status, repo.get(c)?.status]).toEqual(["dismissed", "dismissed"]);
    // 没有要结束的不 notify。
    notify.mockClear();
    inbox.dismissScope({ featureId: 4 });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("InboxService views", () => {
  it("tells the UI who asked, where to jump and whether the terminal is open; filters by feature", () => {
    const child = session("c1", { ticketKey: "BTL-1", repoId: 2 });
    const fix = session("fx", { featureId: 3, fixesSession: "c1" });
    const { inbox, state } = setup({
      sessions: [child, fix], tickets: [ticket("BTL-1", 3, [{ id: 1, repoPath: "/r/web" }, { id: 2, repoPath: "/r/api" }])], open: ["c1"],
    });
    inbox.ask(child, { question: "a" });
    inbox.ask(fix, { question: "b" });
    inbox.report(child, "r", "progress");
    const [a, b] = inbox.pendingDecisionViews();
    expect(a).toMatchObject({ role: "ticket", repo: "api", open: true, target: { page: "ticket", key: "BTL-1", sessionId: "c1" } });
    expect(b).toMatchObject({ role: "fix", repo: null, open: false, target: { page: "feature", id: 3, sessionId: "fx" } });
    expect(inbox.view({ featureId: 3 }).decisions.map((x) => x.text)).toEqual(["a", "b"]);
    expect(inbox.view({ featureId: 3 }).reports.map((x) => [x.text, x.reportKind])).toEqual([["r", "progress"]]);
    expect(inbox.view({ all: true }).decisions).toHaveLength(2);
    state.open.clear();
    expect(inbox.pendingDecisionViews()[0].open).toBe(false);
  });

  it("pages reports for the control conversation: newest first, before is the oldest shown report's id, one extra row tells hasMore", () => {
    const fc = session("fc", { featureId: 3 });
    const { inbox, repo, state } = setup({ sessions: [fc] });
    for (const [text, at] of [["r1", 10], ["r2", 20], ["r3", 30], ["r4", 40]] as const) {
      state.now = at;
      inbox.report(fc, text, "progress");
    }
    repo.addReport({ sessionId: "other", ticketKey: null, featureId: 9, text: "elsewhere", kind: "progress", status: "dismissed", createdAt: 35 });
    const first = inbox.reportsPage({ featureId: 3 }, { limit: 2 });
    expect(first.reports.map((x) => x.text)).toEqual(["r4", "r3"]);
    expect(first.hasMore).toBe(true);
    expect(first.reports[0]).toEqual(inbox.view({ featureId: 3 }).reports[0]);
    const second = inbox.reportsPage({ featureId: 3 }, { limit: 2, before: first.reports[1].id });
    expect(second.reports.map((x) => x.text)).toEqual(["r2", "r1"]);
    expect(second.hasMore).toBe(false);
    expect(inbox.reportsPage({ featureId: 3 }, { limit: 10, before: second.reports[1].id })).toEqual({ reports: [], hasMore: false });
    // 不认识的 id 当没给：第一页。
    expect(inbox.reportsPage({ featureId: 3 }, { limit: 2, before: 99_999 })).toEqual(first);
    expect(inbox.reportsPage({ all: true }, { limit: 3 }).reports.map((x) => x.text)).toEqual(["r4", "elsewhere", "r3"]);
    // 原来的 view 不受影响。
    expect(inbox.view({ featureId: 3 }).reports.map((x) => x.text)).toEqual(["r4", "r3", "r2", "r1"]);
  });

  it("roleOf", () => {
    // 迁移以前的 ticket 总控也只是 ticket session（BTL-246）。
    expect(roleOf(session("x", { ticketKey: "A", coordinator: true }))).toBe("ticket");
    expect(roleOf(session("x", { ticketKey: "A" }))).toBe("ticket");
    expect(roleOf(session("x", { featureId: 1 }))).toBe("feature_coordinator");
    expect(roleOf(session("x", { featureId: 1, fixesSession: "y" }))).toBe("fix");
  });
});

describe("InboxService and the Shipherd 总控 (BTL-190 5)", () => {

  it("does not send other sessions' reports to the Shipherd 总控, and its own reports are only stored", async () => {
    const fc = session("fc", { featureId: 3 });
    const child = session("c1", { ticketKey: "BTL-1" });
    const bt = session("bt", { shipherd: true });
    const { inbox, repo, deliver } = setup({ sessions: [fc, child, bt], tickets: [ticket("BTL-1", 3)], open: ["bt"] });
    // feature 总控上面没有总控（BTL-246）：只存，也不送给 Shipherd 总控。
    const r = inbox.report(fc, "feature done", "done");
    expect(r).toMatchObject({ queued: false, noCoordinator: true });
    await inbox.flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(repo.get(r.id)?.status).toBe("dismissed");
    expect(inbox.report(bt, "巡检完了", "done")).toMatchObject({ queued: false });
    await inbox.flush();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("shows the Shipherd 总控's own questions with role shipherd and a target on its page", () => {
    const bt = session("bt", { shipherd: true });
    const { inbox, repo } = setup({ sessions: [bt] });
    const id = inbox.ask(bt, { question: "先合哪个？" });
    expect(repo.get(id)).toMatchObject({ ticketKey: null, featureId: null });
    expect(inbox.pendingDecisionViews()[0]).toMatchObject({ role: "shipherd", open: true, target: { page: "shipherd", sessionId: "bt" } });
    expect(inbox.view({ all: true }).decisions.map((x) => x.text)).toEqual(["先合哪个？"]);
    expect(roleOf(bt)).toBe("shipherd");
  });

  it("an item whose session is gone still points at the Shipherd 总控 page when it has no ticket or feature", () => {
    const bt = session("bt", { shipherd: true });
    const { inbox, sessions } = setup({ sessions: [bt] });
    inbox.ask(bt, { question: "q" });
    sessions.delete("bt");
    expect(inbox.pendingDecisionViews()[0]).toMatchObject({ role: "shipherd", target: { page: "shipherd", sessionId: "bt" } });
  });
});

describe("InboxService metrics (ws-h)", () => {
  it("records needs_you_answer for a card answer, once per item", () => {
    const s = session("s1", { ticketKey: "BTL-1" });
    const recordEvent = vi.fn<RecordEvent>(() => true);
    const { inbox } = setup({ sessions: [s], tickets: [ticket("BTL-1", null)], recordEvent });
    const id = inbox.ask(s, { question: "q?", options: ["A", "B"] });
    inbox.answer(id, "A");
    expect(recordEvent).toHaveBeenCalledWith("needs_you_answer", { sessionId: "s1", ticketKey: "BTL-1", dedupeKey: `answer:${id}`, data: { via: "card", options: 2 } });
    expect(inbox.answer(id, "   ")).toBe(false);
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it("hands every new question to onAsked", () => {
    const s = session("s1", { ticketKey: "BTL-1" });
    const onAsked = vi.fn();
    const { inbox } = setup({ sessions: [s], tickets: [ticket("BTL-1", null)], onAsked });
    const id = inbox.ask(s, { question: "Which?", options: ["A", "B"], context: "c" });
    expect(onAsked).toHaveBeenCalledWith({ id, sessionId: "s1", ticketKey: "BTL-1", question: "Which?", options: ["A", "B"], context: "c", supersedes: [] });
  });

  it("tells onAsked which pending items the same question replaced", () => {
    const s = session("s1");
    const onAsked = vi.fn();
    const { inbox } = setup({ sessions: [s], onAsked });
    const first = inbox.ask(s, { question: "Which?" });
    inbox.ask(s, { question: "Which?" });
    expect(onAsked).toHaveBeenLastCalledWith(expect.objectContaining({ supersedes: [first] }));
  });

  it("lists unanswered questions by head, not ones answered on the card", () => {
    const s = session("s1");
    const t = session("t1");
    const { inbox } = setup({ sessions: [s, t] });
    const a = inbox.ask(s, { question: "a?" });
    const b = inbox.ask(s, { question: "b?" });
    const c = inbox.ask(t, { question: "c?" });
    expect(inbox.unansweredAsksByHead()).toEqual(new Map([["s1", [a, b]], ["t1", [c]]]));
    inbox.answer(a, "yes");
    expect(inbox.unansweredAsksByHead().get("s1")).toEqual([b]);
    expect(inbox.unansweredAsksByHead().get("other")).toBeUndefined();
  });
});

describe("InboxService choices (ws-j)", () => {
  function withChoices(enabled = "1") {
    const db = memDb();
    const events: { kind: string; data?: Record<string, unknown> }[] = [];
    const recordEvent: RecordEvent = (kind, refs) => (events.push({ kind, data: refs?.data }), true);
    const choices = new ChoiceService({
      choices: new AutoChoicesRepo(db), defaults: new ChoiceDefaultsRepo(db), setting: () => enabled, recordEvent, now: () => 5, markEffective: () => {},
    });
    return { choices, events };
  }

  it("stores a choice report for review instead of the report list, and counts it as auto-resolved", () => {
    const s = session("s1", { ticketKey: "BTL-1" });
    const { choices, events } = withChoices();
    const { inbox, repo } = setup({ sessions: [s], tickets: [ticket("BTL-1", 3)], choices });
    const r = inbox.report(s, "picked rebase", "choice");
    expect(r).toMatchObject({ queued: false, noCoordinator: false });
    expect(repo.reportsForTicket("BTL-1")).toEqual([]);
    expect(choices.list()).toEqual([expect.objectContaining({ source: "rule", sessionId: "s1", ticketKey: "BTL-1", text: "picked rebase" })]);
    expect(events).toEqual([{ kind: "interrupt_auto_resolved", data: { category: "choice", via: "rule" } }]);
  });

  it("answers a matching question with the default right away, without counting an interrupt", async () => {
    const s = session("s1", { ticketKey: "BTL-1" });
    const { choices, events } = withChoices();
    choices.saveDefault({ id: null, pattern: "rebase|merge", answer: "", enabled: true });
    const onAsked = vi.fn();
    const { inbox, repo, deliver } = setup({ sessions: [s], tickets: [ticket("BTL-1", null)], choices, onAsked });
    const id = inbox.ask(s, { question: "Rebase or merge main?", options: ["Rebase", "Merge"], recommended: 0 });
    await settle();
    expect(onAsked).not.toHaveBeenCalled();
    expect(deliver.mock.calls[0]![1]).toContain("Rebase");
    expect(repo.get(id)?.status).toBe("answered");
    expect(choices.list()[0]).toMatchObject({ source: "default" });
    expect(events.map((e) => e.data?.via)).toEqual(["default"]);
  });

  it("leaves questions alone when the switch is off, nothing matches, there are no options, or no recommended option for an empty answer", () => {
    const s = session("s1", { ticketKey: "BTL-1" });
    for (const [enabled, q] of [
      ["0", { question: "Rebase?", options: ["Rebase", "Merge"], recommended: 0 }],
      ["1", { question: "Which colour?", options: ["Red", "Blue"], recommended: 0 }],
      ["1", { question: "Rebase?" }],
      ["1", { question: "Rebase?", options: ["Rebase", "Merge"] }],
    ] as const) {
      const { choices } = withChoices(enabled);
      choices.saveDefault({ id: null, pattern: "rebase", answer: "", enabled: true });
      const onAsked = vi.fn();
      const { inbox, repo } = setup({ sessions: [s], tickets: [ticket("BTL-1", null)], choices, onAsked });
      const id = inbox.ask(s, { ...q, options: "options" in q ? [...q.options] : undefined });
      expect(repo.get(id)?.answer).toBeNull();
      expect(onAsked).toHaveBeenCalledTimes(1);
    }
  });
});
