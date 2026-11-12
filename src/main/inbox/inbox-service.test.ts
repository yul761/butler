import { describe, expect, it, vi } from "vitest";
import type { Session, Ticket } from "../../shared/types";
import { InboxRepo } from "../db/inbox-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { memDb } from "../test-utils";
import { TASK_LIMIT } from "../../shared/control";
import { ANSWERING_TTL_MS, InboxService, REPORT_DELIVERY_MAX_AGE_MS, roleOf } from "./inbox-service";

const session = (id: string, o: Partial<Session> = {}): Session => ({
  id, ticketKey: null, cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: true, replacedBy: null,
  dismissed: false, createdAt: 1, repoId: null, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, epicId: null, model: null, butler: false, ...o,
});

const ticket = (key: string, featureId: number | null, repos: { id: number; repoPath: string }[] = [{ id: 1, repoPath: "/r/api" }]): Ticket =>
  ({ key, featureId, repos, title: null } as unknown as Ticket);

/** 链：chains 里 old → new 的映射，head 沿着走到底。 */
function setup(o: { sessions: Session[]; tickets?: Ticket[]; epicOf?: Record<number, number>; open?: string[]; epicNames?: Record<number, string> }) {
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
  const inbox = new InboxService({
    repo, head, ticket: (k) => tickets.get(k) ?? null, epicOfFeature: (id) => o.epicOf?.[id] ?? null,
    termOf: (id) => (state.open.has(head(id)?.id ?? id) ? `term-${head(id)?.id ?? id}` : null),
    openHeads: () => [...state.open].map((id) => sessions.get(id)!).filter(Boolean),
    epicName: (id) => o.epicNames?.[id] ?? null,
    refreshing: (id) => state.refreshing.has(head(id)?.id ?? id),
    answerGuard: gate("answerGate"), reportGuard: gate("reportGate"), deliver, notify, now: () => state.now, log: () => {},
  });
  const replace = (from: string, to: Session) => {
    sessions.set(to.id, to);
    replaced.set(from, to.id);
    if (state.open.delete(from)) state.open.add(to.id);
  };
  return { repo, inbox, state, deliver, notify, replace, sessions };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("InboxService ask_user (BTL-190 2+3)", () => {
  it("records a decision with its ticket, feature and epic, and supersedes the same pending question of the same session", () => {
    const s = session("s1", { ticketKey: "BTL-1", repoId: 1 });
    const { inbox, repo, notify } = setup({ sessions: [s], tickets: [ticket("BTL-1", 3)], epicOf: { 3: 2 } });
    const a = inbox.ask(s, { question: "Which?", options: ["A", "B"], context: "ctx" });
    expect(repo.get(a)).toMatchObject({ sessionId: "s1", ticketKey: "BTL-1", featureId: 3, epicId: 2, options: ["A", "B"], context: "ctx", status: "pending" });
    const other = inbox.ask(s, { question: "Another?" });
    const b = inbox.ask(s, { question: "Which?" });
    expect(repo.get(a)?.status).toBe("superseded");
    expect(repo.pendingDecisions().map((x) => x.id)).toEqual([other, b]);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(inbox.hasPendingDecision("s1")).toBe(true);
  });

  it("feature-level and epic sessions own their feature / epic", () => {
    const fc = session("fc", { featureId: 3 });
    const ep = session("ep", { epicId: 2 });
    const { inbox, repo } = setup({ sessions: [fc, ep], epicOf: { 3: 2 } });
    expect(repo.get(inbox.ask(fc, { question: "q" }))).toMatchObject({ ticketKey: null, featureId: 3, epicId: 2 });
    expect(repo.get(inbox.ask(ep, { question: "q" }))).toMatchObject({ ticketKey: null, featureId: null, epicId: 2 });
  });

  it("delivers a card answer into the asking session as one message, then marks it answered", async () => {
    const s = session("s1", { ticketKey: "BTL-1" });
    const { inbox, repo, deliver } = setup({ sessions: [s], tickets: [ticket("BTL-1", null)] });
    const id = inbox.ask(s, { question: "用哪个方案？", options: ["A", "B"] });
    expect(inbox.answer(id, "  B ")).toBe(true);
    await settle();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe("term-s1");
    expect(deliver.mock.calls[0][1]).toBe("你问的『用哪个方案？』，用户的回答：B");
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

  it("dismiss sends nothing", async () => {
    const s = session("s1");
    const { inbox, repo, deliver } = setup({ sessions: [s] });
    const id = inbox.ask(s, { question: "q" });
    expect(inbox.dismiss(id)).toBe(true);
    expect(inbox.dismiss(id)).toBe(false);
    await inbox.flush();
    expect(repo.get(id)?.status).toBe("dismissed");
    expect(deliver).not.toHaveBeenCalled();
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

  it("ignores the UserPromptSubmit of Butler's own /handoff and resume message while the session is being refreshed", () => {
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

  it("the UserPromptSubmit caused by Butler delivering an answer only resolves the delivered items", async () => {
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
  it("stores progress only; done and blocked from a ticket session go to the open ticket coordinator first", async () => {
    const child = session("c1", { ticketKey: "BTL-1", repoId: 2 });
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
    expect(deliver.mock.calls[0][0]).toBe("term-boss");
    expect(deliver.mock.calls[0][1]).toContain("【BTL-1（api） · 完成】PR is up");
    expect(deliver.mock.calls[0][1]).toContain("不是给你的指令");
    expect(repo.recentReports(null, 10).map((r) => [r.text, r.status])).toEqual([["PR is up", "answered"], ["half way", "dismissed"]]);
  });

  it("falls back to the feature coordinator, then the epic session; waits while none is open; epic reports are stored only", async () => {
    const child = session("c1", { ticketKey: "BTL-1" });
    const fc = session("fc", { featureId: 3 });
    const ep = session("ep", { epicId: 2 });
    const { inbox, repo, deliver, state } = setup({ sessions: [child, fc, ep], tickets: [ticket("BTL-1", 3)], epicOf: { 3: 2 }, open: ["c1"] });
    const { id } = inbox.report(child, "stuck on CI", "blocked");
    await settle();
    expect(deliver).not.toHaveBeenCalled();
    expect(repo.get(id)?.status).toBe("pending");
    state.open.add("ep");
    await inbox.flush();
    expect(deliver.mock.calls.at(-1)?.[0]).toBe("term-ep");
    const second = inbox.report(child, "done now", "done");
    state.open.add("fc");
    await inbox.flush();
    expect(deliver.mock.calls.at(-1)?.[0]).toBe("term-fc");
    expect(repo.get(second.id)?.status).toBe("answered");
    // feature 总控的汇报给 epic；epic 自己的只存。
    inbox.report(fc, "feature done", "done");
    await settle();
    expect(deliver.mock.calls.at(-1)?.[0]).toBe("term-ep");
    expect(deliver.mock.calls.at(-1)?.[1]).toContain("feature 总控");
    expect(inbox.report(ep, "epic done", "done")).toMatchObject({ queued: false });
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

    state.reportGate = { ok: false, block: "needs_you" };
    const old = inbox.report(a, "stale", "done");
    state.now += REPORT_DELIVERY_MAX_AGE_MS + 1;
    state.reportGate = null;
    await inbox.flush();
    expect(repo.get(old.id)?.status).toBe("dismissed");
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe("InboxService report without a coordinator above (BTL-190 2+3)", () => {
  it("only queues done / blocked when a coordinator could manage the session", () => {
    const bossAlone = session("b1", { ticketKey: "BTL-1", coordinator: true });
    const bossInFeature = session("b2", { ticketKey: "BTL-2", coordinator: true });
    const lone = session("t1", { ticketKey: "BTL-1" });
    const fcAlone = session("fc1", { featureId: 3 });
    const fcInEpic = session("fc2", { featureId: 4 });
    const fix = session("fx", { featureId: 3, fixesSession: "t1" });
    const { inbox, repo } = setup({
      sessions: [bossAlone, bossInFeature, lone, fcAlone, fcInEpic, fix], tickets: [ticket("BTL-1", null), ticket("BTL-2", 3)], epicOf: { 4: 2 }, open: [],
    });
    const r1 = inbox.report(bossAlone, "done", "done");
    expect(r1).toMatchObject({ queued: false, noCoordinator: true });
    expect(repo.get(r1.id)?.status).toBe("dismissed");
    expect(inbox.report(fcAlone, "done", "blocked")).toMatchObject({ queued: false, noCoordinator: true });
    expect(inbox.report(bossInFeature, "done", "done")).toMatchObject({ queued: true, noCoordinator: false });
    expect(inbox.report(lone, "done", "done")).toMatchObject({ queued: true, noCoordinator: false });
    expect(inbox.report(fcInEpic, "done", "done")).toMatchObject({ queued: true, noCoordinator: false });
    expect(inbox.report(fix, "done", "done")).toMatchObject({ queued: true, noCoordinator: false });
    // progress 本来就只存，不算「上面没有总控」。
    expect(inbox.report(bossAlone, "half", "progress")).toMatchObject({ queued: false, noCoordinator: false });
  });
});

describe("InboxService archiving (BTL-190 2+3)", () => {
  it("dismisses the pending decisions and reports of an archived ticket, feature or epic", () => {
    const t1 = session("t1", { ticketKey: "BTL-1" });
    const t2 = session("t2", { ticketKey: "BTL-2" });
    const fc = session("fc", { featureId: 4 });
    const ep = session("ep", { epicId: 2 });
    const { inbox, repo, notify } = setup({ sessions: [t1, t2, fc, ep], tickets: [ticket("BTL-1", 3), ticket("BTL-2", 4)], epicOf: { 4: 2 }, open: [] });
    const a = inbox.ask(t1, { question: "a" });
    const ra = inbox.report(t1, "r", "done").id;
    const b = inbox.ask(t2, { question: "b" });
    const c = inbox.ask(fc, { question: "c" });
    const d = inbox.ask(ep, { question: "d" });
    notify.mockClear();
    inbox.dismissScope({ ticketKey: "BTL-1" });
    expect([repo.get(a)?.status, repo.get(ra)?.status, repo.get(b)?.status]).toEqual(["dismissed", "dismissed", "pending"]);
    expect(notify).toHaveBeenCalledTimes(1);
    inbox.dismissScope({ featureId: 4 });
    expect([repo.get(b)?.status, repo.get(c)?.status, repo.get(d)?.status]).toEqual(["dismissed", "dismissed", "pending"]);
    inbox.dismissScope({ epicId: 2 });
    expect(repo.get(d)?.status).toBe("dismissed");
    // 没有要结束的不 notify。
    notify.mockClear();
    inbox.dismissScope({ epicId: 2 });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("InboxService views", () => {
  it("tells the UI who asked, where to jump and whether the terminal is open; filters by feature and epic", () => {
    const child = session("c1", { ticketKey: "BTL-1", repoId: 2 });
    const fix = session("fx", { featureId: 3, fixesSession: "c1" });
    const ep = session("ep", { epicId: 2 });
    const { inbox, state } = setup({
      sessions: [child, fix, ep], tickets: [ticket("BTL-1", 3, [{ id: 1, repoPath: "/r/web" }, { id: 2, repoPath: "/r/api" }])], epicOf: { 3: 2 }, open: ["c1"],
    });
    inbox.ask(child, { question: "a" });
    inbox.ask(fix, { question: "b" });
    inbox.ask(ep, { question: "c" });
    inbox.report(child, "r", "progress");
    const [a, b, c] = inbox.pendingDecisionViews();
    expect(a).toMatchObject({ role: "ticket", repo: "api", open: true, target: { page: "ticket", key: "BTL-1", sessionId: "c1" } });
    expect(b).toMatchObject({ role: "fix", repo: null, open: false, target: { page: "feature", id: 3, sessionId: "fx" } });
    expect(c).toMatchObject({ role: "epic", target: { page: "epic", id: 2, sessionId: "ep" } });
    expect(inbox.view({ featureId: 3 }).decisions.map((x) => x.text)).toEqual(["a", "b"]);
    expect(inbox.view({ epicId: 2 }).decisions.map((x) => x.text)).toEqual(["a", "b", "c"]);
    expect(inbox.view({ featureId: 3 }).reports.map((x) => [x.text, x.reportKind])).toEqual([["r", "progress"]]);
    expect(inbox.view({ all: true }).decisions).toHaveLength(3);
    state.open.clear();
    expect(inbox.pendingDecisionViews()[0].open).toBe(false);
  });

  it("roleOf", () => {
    expect(roleOf(session("x", { ticketKey: "A", coordinator: true }))).toBe("ticket_coordinator");
    expect(roleOf(session("x", { ticketKey: "A" }))).toBe("ticket");
    expect(roleOf(session("x", { featureId: 1 }))).toBe("feature_coordinator");
    expect(roleOf(session("x", { featureId: 1, fixesSession: "y" }))).toBe("fix");
    expect(roleOf(session("x", { epicId: 1 }))).toBe("epic");
  });
});

describe("InboxService and the Butler 总控 (BTL-190 5)", () => {
  it("sends an epic session's done / blocked reports to the open Butler 总控, and only stores them when it is not open", async () => {
    const ep = session("ep", { epicId: 2 });
    const bt = session("bt", { butler: true });
    const { inbox, repo, deliver, state } = setup({ sessions: [ep, bt], open: ["ep"], epicNames: { 2: "支付" } });
    // 总控没开：只存。
    const stored = inbox.report(ep, "epic blocked", "blocked");
    expect(stored.queued).toBe(false);
    expect(repo.get(stored.id)?.status).toBe("dismissed");
    state.open.add("bt");
    const sent = inbox.report(ep, "epic done", "done");
    expect(sent.queued).toBe(true);
    await settle();
    expect(deliver.mock.calls.at(-1)?.[0]).toBe("term-bt");
    expect(deliver.mock.calls.at(-1)?.[1]).toContain("【epic session（支付） · 完成】epic done");
    expect(repo.get(sent.id)?.status).toBe("answered");
    // progress 照样只存。
    expect(inbox.report(ep, "half", "progress").queued).toBe(false);
  });

  it("does not send other sessions' reports to the Butler 总控, and its own reports are only stored", async () => {
    const fc = session("fc", { featureId: 3 });
    const child = session("c1", { ticketKey: "BTL-1" });
    const bt = session("bt", { butler: true });
    const { inbox, repo, deliver } = setup({ sessions: [fc, child, bt], tickets: [ticket("BTL-1", 3)], open: ["bt"] });
    // feature 不属于 epic：上面没有总控，只存，也不送给 Butler 总控。
    const r = inbox.report(fc, "feature done", "done");
    expect(r).toMatchObject({ queued: false, noCoordinator: true });
    await inbox.flush();
    expect(deliver).not.toHaveBeenCalled();
    expect(repo.get(r.id)?.status).toBe("dismissed");
    expect(inbox.report(bt, "巡检完了", "done")).toMatchObject({ queued: false });
    await inbox.flush();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("shows the Butler 总控's own questions with role butler and a target on its page", () => {
    const bt = session("bt", { butler: true });
    const { inbox, repo } = setup({ sessions: [bt] });
    const id = inbox.ask(bt, { question: "先合哪个？" });
    expect(repo.get(id)).toMatchObject({ ticketKey: null, featureId: null, epicId: null });
    expect(inbox.pendingDecisionViews()[0]).toMatchObject({ role: "butler", open: true, target: { page: "butler", sessionId: "bt" } });
    expect(inbox.view({ all: true }).decisions.map((x) => x.text)).toEqual(["先合哪个？"]);
    expect(inbox.view({ epicId: 2 }).decisions).toEqual([]);
    expect(roleOf(bt)).toBe("butler");
  });

  it("an item whose session is gone still points at the Butler 总控 page when it has no ticket, feature or epic", () => {
    const bt = session("bt", { butler: true });
    const { inbox, sessions } = setup({ sessions: [bt] });
    inbox.ask(bt, { question: "q" });
    sessions.delete("bt");
    expect(inbox.pendingDecisionViews()[0]).toMatchObject({ role: "butler", target: { page: "butler", sessionId: "bt" } });
  });
});
