import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, utimesSync } from "node:fs";
import { M } from "../strings";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runMailbox } from "../../../hook/mailbox";
import type { Session } from "../../shared/types";
import { SessionMessagesRepo } from "../db/session-messages-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { memDb } from "../test-utils";
import { AGE_NOTE_MS, type AwaitingUser, JUDGING_HOLD_MS, UNSURE_DELIVER_MS, Mailbox, MESSAGE_KEEP_MS, PROBE_DENSE_MS, PROBE_FIRST_GAP_MS, PROBE_MAX_GAP_MS, PRUNE_EVERY_MS, REPLY_WAIT_MS, STUCK_RECEIPT_MS, STUCK_TURN_RECEIPT_MS, TAKEN_STALE_MS } from "./mailbox";

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

/** 一个假的世界：sessions 的 head 链、开着的终端（终端 id = 打开时的 session id）、guard、deliver。 */
function world() {
  const root = mkdtempSync(join(tmpdir(), "mbox-"));
  const repo = new SessionMessagesRepo(memDb());
  const sessions = new Map<string, Partial<Session> & { id: string; replacedBy?: string }>();
  const terms = new Map<string, string>(); // termId -> 打开时的 session id
  const replies = new Map<string, { id: string; text: string; at: number | null }>();
  let now = 1_000_000;
  const blocked = new Set<string>();
  const needsYou = new Set<string>();
  const delivered: { term: string; text: string }[] = [];
  let deliverResult: DeliverResult = "sent";
  const interrupts: string[] = [];
  const typed: string[] = [];
  const woken: string[] = [];
  const deliveredMsgs: { id: string; via: string | null }[] = [];
  const held = new Set<string>();
  /** head -> 它的总控（fromController 认的发件人）。 */
  const controllerOf = new Map<string, string>();
  /** head -> 它管的 session（fromSubordinate 认的发件人，BTL-279）。 */
  const subordinates = new Map<string, Set<string>>();
  /** head -> 挡住它的 busy 细分（不在里面的按 turn）。 */
  const busyReason = new Map<string, "turn" | "unsure">();
  const typing = new Set<string>();
  const drafts = new Set<string>();
  const logs: string[] = [];
  let messageNotices = 0;
  /** recheckAfter 收到的 lenient（BTL-279：粘贴前复查也要按同样宽松的标准，不然复查一定不过）。 */
  const lenientRechecks: boolean[] = [];
  /** head -> 接替它的、开着的那个（新开的全局总控、同一个 epic 新开的总控；BTL-279）。 */
  const successors = new Map<string, string>();
  /** 休眠着的 head（BTL-279 review：不改投，叫醒它）。 */
  const hibernated = new Set<string>();
  /** 这些 head 记录说在干活、屏幕证据说停了：guard 校正成在等，按停下处理（和 index.ts 的 healed 一样放到下一拍）。 */
  const healOnCheck = new Set<string>();
  /** transcript 显示最近一轮已经结束的 head（turnClosed）。 */
  const turnClosed = new Set<string>();
  /** 读过谁的最后一条回复（lastReply）。 */
  const replyReads: string[] = [];
  /** guard 被问过的 head（按顺序）。 */
  const checked: string[] = [];
  /** coordinatorAnswered 的调用：head 加上那几个 ask_user、答案、谁答的、那条消息排进来的时间。 */
  const coordinatorAnswered: ({ head: string } & { asks: number[]; answer: string; by: string; queuedAt: number })[] = [];
  /**
   * needsYou 里的 session 在等用户回答什么（awaitingUser）：没设的当作用文字问了一个问题（时间 0，早于所有消息）；
   * 设成 null 是刚停下、还没判断完（A1）。
   */
  const awaiting = new Map<string, AwaitingUser | null>();
  const head = (id: string): Session | null => {
    let s = sessions.get(id);
    while (s?.replacedBy) s = sessions.get(s.replacedBy);
    return (s as Session) ?? null;
  };
  const termOf = (id: string): string | null => {
    const h = head(id)?.id ?? id;
    for (const [t, sid] of terms) if ((head(sid)?.id ?? sid) === h) return t;
    return null;
  };
  /** 等输入框的那段时间里发生的事（测试用）：deliver 调 recheck 之前跑一次。 */
  const whileWaiting: { run: (() => void) | null } = { run: null };
  const deliver = vi.fn(async (term: string, text: string, recheck: () => boolean): Promise<DeliverResult> => {
    const run = whileWaiting.run;
    whileWaiting.run = null;
    run?.();
    if (!recheck()) return "blocked";
    delivered.push({ term, text });
    return deliverResult;
  });
  const mb = new Mailbox({
    repo, root, head, termOf, openTerms: () => [...terms.keys()],
    check: (id, o): DeliveryCheck => {
      checked.push(head(id)?.id ?? id);
      const t = termOf(id);
      if (t === null) return { ok: false, block: "closed" };
      const h = head(id)!;
      if (healOnCheck.has(h.id) && !h.waitingForInput) {
        h.waitingForInput = true;
        setTimeout(() => void mb.stopped(h.id), 0);
        return { ok: false, block: "busy", busy: "unsure" };
      }
      // 和真的 guard 一样：force 只跳过「看着停了、还没安静够久」（unsure），屏幕上看得出在干活（turn）照样挡。
      const busy = busyReason.get(h.id) ?? "turn";
      if ((!h.waitingForInput || blocked.has(h.id)) && !((o.force || o.lenient) && busy === "unsure")) return { ok: false, block: "busy", busy };
      if (!o.force && !o.answer && needsYou.has(h.id)) return { ok: false, block: "needs_you" };
      if (!o.force && typing.has(h.id)) return { ok: false, block: "typing" };
      if (drafts.has(h.id)) return { ok: false, block: "draft" };
      return { ok: true, termId: t, headId: h.id };
    },
    fromController: (m, h) => controllerOf.get(h) === m.fromSession,
    fromSubordinate: (m, h) => m.fromSession !== null && (subordinates.get(h)?.has(m.fromSession) ?? false),
    recheckAfter: (_id, _p, o) => (lenientRechecks.push(o.lenient === true), () => true),
    deliver,
    canInterrupt: () => true,
    interrupt: (t) => interrupts.push(t),
    interruptRecheck: () => () => true,
    lastReply: (id) => (replyReads.push(head(id)?.id ?? id), replies.get(head(id)?.id ?? id) ?? null),
    turnClosed: (h) => turnClosed.has(h),
    nameOf: (id) => (id === null ? "Shipherd" : `S(${id})`),
    typing: (h, phase) => typed.push(`${h}:${phase}`),
    coordinatorAnswered: (h, o) => coordinatorAnswered.push({ head: h, ...o }),
    awaitingUser: (h) => (!needsYou.has(h) ? null : awaiting.has(h) ? awaiting.get(h)! : { asks: [], text: { reason: "asked in text", at: 0 } }),
    wake: (h) => woken.push(h),
    successor: (h) => successors.get(h) ?? null,
    hibernated: (h) => hibernated.has(h),
    delivered: (m) => deliveredMsgs.push({ id: m.id, via: m.via }),
    held: (h) => held.has(h),
    featureOf: (h) => (h === "t9" ? 9 : null),
    notify: () => {},
    notifyMessages: () => messageNotices++,
    now: () => now,
    log: (m) => logs.push(m),
  });
  const add = (id: string, waiting: boolean, open = true) => {
    sessions.set(id, { id, waitingForInput: waiting });
    if (open) terms.set(id, id);
  };
  const dirFiles = (term: string) => (existsSync(join(root, term)) ? readdirSync(join(root, term)).sort() : null);
  return {
    root, repo, mb, sessions, terms, replies, blocked, needsYou, delivered, deliver, interrupts, typed, woken, deliveredMsgs, held, add, dirFiles,
    controllerOf, subordinates, busyReason, typing, lenientRechecks, successors, hibernated, healOnCheck, turnClosed, replyReads, checked, drafts, logs, coordinatorAnswered, awaiting, whileWaiting,
    setWaiting: (id: string, w: boolean) => (sessions.get(id)!.waitingForInput = w),
    tick: (ms: number) => (now += ms),
    now: () => now,
    failDeliver: (r: DeliverResult) => (deliverResult = r),
    messageNotices: () => messageNotices,
    hook: (term: string, tool = "Read") => runMailbox(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: tool }), { SHIPHERD_SESSION: term }, root),
  };
}

const msg = (to: string, body: string, extra: Record<string, unknown> = {}) => ({ kind: "instruction" as const, from: "boss", to, featureId: 1, body, ...extra });

describe("Mailbox", () => {
  it("does not project for a held session (being refreshed); once released, sync and flush hand it over", async () => {
    const w = world();
    w.add("t1", false);
    w.held.add("t1");
    w.mb.send(msg("t1", "after the refresh"));
    await flushPromises();
    expect(w.dirFiles("t1")).toBeNull();
    w.held.delete("t1");
    w.mb.syncTerm("t1");
    expect(w.dirFiles("t1")).toHaveLength(1);
  });

  it("a patrol never goes through the hook, even after a sweep or a rebuild: it waits for the stop and is typed in; other kinds still go through the hook (BTL-279 fifth review)", async () => {
    const w = world();
    w.add("bt", false);
    const patrol = w.mb.send({ kind: "patrol", from: null, to: "bt", featureId: null, body: "daily patrol", ref: "patrol:1" });
    await flushPromises();
    expect(w.dirFiles("bt")).toBeNull();
    w.mb.sweep("bt");
    w.mb.rebuild();
    expect(w.dirFiles("bt")).toBeNull();
    expect(w.hook("bt").out).toBe("");
    w.mb.send(msg("bt", "CI failed"));
    await flushPromises();
    const ctx = JSON.parse(w.hook("bt").out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("CI failed");
    expect(ctx).not.toContain("daily patrol");
    expect(w.repo.get(patrol.id)?.status).toBe("queued");
    w.setWaiting("bt", true);
    await w.mb.stopped("bt");
    expect(w.delivered.map((d) => d.text).join("\n")).toContain("daily patrol");
    expect(w.deliveredMsgs).toContainEqual({ id: patrol.id, via: "input" });
  });

  for (const blocker of ["needs_you", "draft"] as const) {
    it(`a patrol held back by ${blocker} while the control is stopped is still never written to disk, before or after it gets busy (BTL-279 sixth review, surviving mutant #4)`, async () => {
      const w = world();
      w.add("bt", true);
      (blocker === "needs_you" ? w.needsYou : w.drafts).add("bt");
      const patrol = w.mb.send({ kind: "patrol", from: null, to: "bt", featureId: null, body: "daily patrol", ref: "patrol:1" });
      await flushPromises();
      expect(w.repo.get(patrol.id)).toMatchObject({ status: "queued", blockedReason: blocker });
      w.mb.syncTerm("bt");
      expect(w.dirFiles("bt")).toBeNull();
      // 总控变忙了（用户自己开了一轮）：巡检也不能这时候写出去、被 hook 带进这一轮。
      w.setWaiting("bt", false);
      w.mb.syncTerm("bt");
      await w.mb.flush("bt");
      expect(w.dirFiles("bt")).toBeNull();
      expect(w.hook("bt").out).toBe("");
      expect(w.repo.get(patrol.id)?.status).toBe("queued");
    });
  }

  it("a patrol's ETA says it waits for the turn to end, not for a tool call; other kinds keep theirs (BTL-279 sixth review)", () => {
    for (const reason of ["turn", "auto_input", "deliver_failed"] as const) {
      const patrol = Mailbox.note({ delivery: "queued", reason, since: 0, kind: "patrol" }, 0);
      expect(patrol).toContain(M().mailboxEtaPatrol);
      expect(patrol).not.toContain("调用工具");
      expect(Mailbox.note({ delivery: "queued", reason, since: 0, kind: "shipherd" }, 0)).toContain(M().mailboxEta[reason]);
    }
    expect(Mailbox.note({ delivery: "queued", reason: "closed", since: 0, kind: "patrol" }, 0)).toContain(M().mailboxEta.closed);
  });

  it("pendingFor takes the kind of the message that is blocked, not of the oldest one (BTL-279 seventh review, surviving mutant M21)", async () => {
    const w = world();
    w.add("bt", false);
    w.mb.send({ kind: "shipherd", from: null, to: "bt", featureId: null, body: "older", ref: "s:1" });
    w.mb.send({ kind: "patrol", from: null, to: "bt", featureId: null, body: "daily patrol", ref: "patrol:1" });
    await flushPromises();
    const [older] = w.repo.queued().filter((m) => m.kind === "shipherd");
    // 最早那条这会儿没有挡住的原因（刚排进来、还没 tick 到），挡住的是巡检那条。
    w.repo.setBlocked([older.id], null, w.now());
    expect(w.mb.pendingFor("bt")).toMatchObject({ queued: 2, oldestQueuedAt: older.queuedAt, reason: "turn", kind: "patrol" });
    expect(w.mb.pendingView("bt")?.note).toContain(M().mailboxEtaPatrol);
  });

  it("list_sessions' pending note for a busy Shipherd control with a patrol queued uses the patrol ETA (BTL-279 sixth review)", async () => {
    const w = world();
    w.add("bt", false);
    w.mb.send({ kind: "patrol", from: null, to: "bt", featureId: null, body: "daily patrol", ref: "patrol:1" });
    await flushPromises();
    expect(w.mb.pendingView("bt")?.note).toContain(M().mailboxEtaPatrol);
    const r = await w.mb.settle(w.repo.queued()[0].id, 0);
    expect(Mailbox.note(r, w.now())).toContain(M().mailboxEtaPatrol);
  });

  it("types the user's own words in as they are, never batched with Shipherd's messages; through the hook they carry a note", async () => {
    const w = world();
    w.add("t1", true);
    w.blocked.add("t1");
    w.mb.send({ kind: "user", from: null, to: "t1", featureId: null, body: "please also fix the title" });
    w.mb.send({ kind: "user", from: null, to: "t1", featureId: null, body: "and the footer" });
    w.mb.send(msg("t1", "CI failed"));
    await flushPromises();
    w.blocked.delete("t1");
    await w.mb.flush("t1");
    expect(w.delivered.map((d) => d.text)).toEqual(["please also fix the title\n\nand the footer"]);
    await w.mb.flush("t1");
    expect(w.delivered).toHaveLength(2);
    expect(w.delivered[1].text).toContain("CI failed");
    expect(w.delivered[1].text).not.toContain("footer");

    const b = world();
    b.add("t2", false);
    b.mb.send({ kind: "user", from: null, to: "t2", featureId: null, body: "rename it" });
    const ctx = JSON.parse(b.hook("t2").out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("rename it");
    expect(ctx).toMatch(/对话 tab|conversation tab/);
  });

  it("the user's own words, an answer and a refresh resume go in while the session needs you; Shipherd's other messages wait", async () => {
    const w = world();
    w.add("t1", true);
    w.needsYou.add("t1");
    w.mb.send(msg("t1", "CI failed"));
    await flushPromises();
    expect(w.delivered).toEqual([]);
    w.mb.send({ kind: "user", from: null, to: "t1", featureId: null, body: "yes, go with B" });
    await flushPromises();
    // 用户自己的话排在 CI 后面也进去：它不该被「需要你」挡住，CI 那条接着等。
    expect(w.delivered.map((d) => d.text)).toEqual(["yes, go with B"]);
    await w.mb.flush("t1");
    expect(w.delivered).toHaveLength(1);
    w.needsYou.delete("t1");
    await w.mb.flush("t1");
    expect(w.delivered[1].text).toContain("CI failed");

    const u = world();
    u.add("t2", true);
    u.needsYou.add("t2");
    u.mb.send({ kind: "user", from: null, to: "t2", featureId: null, body: "yes, go with B" });
    await flushPromises();
    expect(u.delivered.map((d) => d.text)).toEqual(["yes, go with B"]);
    // 用户自己的话不算 Shipherd 输入的：它的 UserPromptSubmit 照样算用户回答了。
    expect(u.typed).toEqual([]);

    const r = world();
    r.add("t3", true);
    r.needsYou.add("t3");
    r.mb.send({ kind: "refresh", from: null, to: "t3", featureId: null, body: "recall the handoff and carry on" });
    await flushPromises();
    expect(r.delivered).toHaveLength(1);
    expect(r.typed).toEqual(["t3:start", "t3:sent"]);
  });

  it("after a refresh the carry-on message goes in first, ahead of what was queued during the refresh", async () => {
    const w = world();
    w.add("t1", true);
    // 换新期间：不投影，guard 也挡着直接输入（refreshing）。
    w.held.add("t1");
    w.blocked.add("t1");
    w.mb.send({ kind: "user", from: null, to: "t1", featureId: null, body: "also rename it" });
    await flushPromises();
    w.held.delete("t1");
    w.blocked.delete("t1");
    w.mb.send({ kind: "refresh", from: null, to: "t1", featureId: null, body: "recall the handoff and carry on" });
    await flushPromises();
    // 原样输入，不带信箱的说明：它是新上下文的第一句话（session 的名字也从它来）。
    expect(w.delivered[0].text).toBe("recall the handoff and carry on");
    await w.mb.flush("t1");
    expect(w.delivered[1].text).toBe("also rename it");
  });

  it("a message without an epic is filed under the recipient's epic, so that epic's message list shows it", () => {
    const w = world();
    w.add("t9", false);
    w.mb.send({ kind: "ci", from: null, to: "t9", featureId: null, body: "CI passed", ref: "ci:pr:1" });
    expect(w.repo.recent({ featureId: 9 }, 5).map((m) => m.body)).toEqual(["CI passed"]);
    w.mb.send({ ...msg("t9", "from epic 1"), featureId: 1 });
    expect(w.repo.recent({ featureId: 1 }, 5).map((m) => m.body)).toEqual(["from epic 1"]);
  });

  it("a busy target gets the message through the hook at its next tool call; the sweep records it as delivered via hook", async () => {
    const w = world();
    w.add("t1", false);
    expect(w.mb.send(msg("t1", "do X"))).toMatchObject({ state: "busy" });
    await flushPromises();
    expect(w.delivered).toEqual([]);
    expect(w.dirFiles("t1")).toHaveLength(1);
    const run = w.hook("t1");
    expect(JSON.parse(run.out).hookSpecificOutput.additionalContext).toContain("do X");
    run.commit();
    w.mb.sweep("t1");
    const [m] = w.repo.recent({ featureId: 1 }, 5);
    expect(m).toMatchObject({ status: "delivered", via: "hook" });
    // 送完目录没了：下一次工具调用只是一次 test。
    expect(w.dirFiles("t1")).toBeNull();
  });

  it("a message being typed into a just-opened terminal is not projected for the hook meanwhile (no second delivery)", async () => {
    const w = world();
    w.add("t1", false, false);
    w.mb.send({ ...msg("t1", "wake up"), kind: "shipherd", hold: true });
    let release: (r: "sent") => void = () => {};
    // 终端刚开，还没登记到 session 上：这时没有投影。
    const typing = w.mb.opened("t1", "new-term", () => new Promise((res) => (release = res)));
    expect(w.dirFiles("new-term")).toBeNull();
    // 等输入框的时候 SessionStart 登记了终端、对一遍投影，tick 也来：不能把这条写出去给 hook。
    w.terms.set("new-term", "t1");
    w.sessions.set("new-term", { id: "new-term", replacedBy: "t1" });
    w.mb.syncTerm("new-term");
    await w.mb.tick();
    expect(w.dirFiles("new-term")).toBeNull();
    release("sent");
    expect(await typing).toBe(true);
    expect(w.repo.recent({ featureId: 1 }, 5)[0]).toMatchObject({ status: "delivered", via: "input" });
    expect(w.dirFiles("new-term")).toBeNull();
  });

  it("a hook that sent the old body before a same-ref replacement does not count as delivering the new one", async () => {
    const w = world();
    w.add("t1", false);
    w.mb.send({ ...msg("t1", "answer: A"), kind: "answer", ref: "answer:7" });
    await flushPromises();
    const run = w.hook("t1"); // 拿着旧的那份
    expect(JSON.parse(run.out).hookSpecificOutput.additionalContext).toContain("answer: A");
    w.mb.send({ ...msg("t1", "answer: B"), kind: "answer", ref: "answer:7" });
    run.commit();
    w.mb.sweep("t1");
    const [m] = w.repo.recent({ featureId: 1 }, 5);
    expect(m).toMatchObject({ status: "queued", body: "answer: B" });
    // 新的那份又写了出去，下一次工具调用送。
    const again = w.hook("t1");
    expect(JSON.parse(again.out).hookSpecificOutput.additionalContext).toContain("answer: B");
    again.commit();
    w.mb.sweep("t1");
    expect(w.repo.recent({ featureId: 1 }, 5)[0]).toMatchObject({ status: "delivered", via: "hook" });
  });

  it("opened types every queued message into a terminal just opened for it, without the guard", async () => {
    const w = world();
    w.add("t1", false);
    w.mb.send({ ...msg("t1", "wake up"), kind: "shipherd" });
    const typedIn: string[] = [];
    expect(await w.mb.opened("t1", "t1", async (_t, text) => (typedIn.push(text), "sent"))).toBe(true);
    expect(typedIn[0]).toContain("wake up");
    expect(w.deliver).not.toHaveBeenCalled();
    expect(w.repo.recent({ featureId: 1 }, 5)[0]).toMatchObject({ status: "delivered", via: "input" });
    expect(w.dirFiles("t1")).toBeNull();
  });

  it("withdraw takes a queued message back off the disk and out of the queue; queuedRefs lists by prefix", async () => {
    const w = world();
    w.add("t1", false);
    w.mb.send({ ...msg("t1", "c"), kind: "comments", ref: "comments:4" });
    w.mb.send({ ...msg("t1", "r"), kind: "review", ref: "prereview:9" });
    expect(w.mb.queuedRefs("comments")).toEqual(["comments:4"]);
    w.mb.withdraw("comments:4");
    expect(w.mb.queuedRefs("comments")).toEqual([]);
    expect(w.dirFiles("t1")).toHaveLength(1);
    w.mb.withdraw("prereview:9");
    expect(w.dirFiles("t1")).toBeNull();
    expect(w.repo.queued()).toEqual([]);
  });

  it("a stopped target gets every queued message typed in as one input, and the folder is removed", async () => {
    const w = world();
    w.add("t1", false);
    w.mb.send(msg("t1", "one"));
    w.mb.send({ ...msg("t1", "two"), kind: "report" });
    w.setWaiting("t1", true);
    await w.mb.stopped("t1");
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0].text).toMatch(/one[\s\S]*two/);
    expect(w.repo.queued()).toEqual([]);
    expect(w.repo.recent({ featureId: 1 }, 5).every((m) => m.via === "input")).toBe(true);
    expect(w.dirFiles("t1")).toBeNull();
    expect(w.typed).toEqual(["t1:start", "t1:sent"]);
  });

  it("never refuses: a blocked or closed target keeps the message queued until it can take it", async () => {
    const w = world();
    w.add("t1", true);
    w.blocked.add("t1");
    w.mb.send(msg("t1", "later"));
    await flushPromises();
    expect(w.repo.queued()).toHaveLength(1);
    w.blocked.delete("t1");
    await w.mb.tick();
    expect(w.repo.queued()).toEqual([]);

    w.add("closed", true, false);
    expect(w.mb.send(msg("closed", "when you open")).state).toBe("closed");
    expect(w.dirFiles("closed")).toBeNull();
    // 终端打开、停在输入框：第一件事就是送进去。
    w.terms.set("closed", "closed");
    await w.mb.stopped("closed");
    expect(w.delivered.at(-1)?.text).toContain("when you open");
  });

  it("a failed input puts the messages back for the hook or the next try", async () => {
    const w = world();
    w.add("t1", true);
    w.failDeliver("timeout");
    w.mb.send(msg("t1", "x"));
    await flushPromises();
    await flushPromises();
    expect(w.repo.queued()).toHaveLength(1);
    expect(w.dirFiles("t1")?.every((n) => n.endsWith(".json"))).toBe(true);
  });

  it("follows the replacement chain: a message for an old id goes to the session that replaced it", async () => {
    const w = world();
    w.add("old", false);
    w.sessions.set("new", { id: "new", waitingForInput: true });
    w.sessions.get("old")!.replacedBy = "new";
    w.mb.send(msg("old", "hi"));
    await flushPromises();
    expect(w.delivered).toEqual([{ term: "old", text: expect.stringContaining("hi") }]);
  });

  it("skips files the hook already took, and a crashed hook's claim goes back after a minute", async () => {
    const w = world();
    w.add("t1", false);
    w.mb.send(msg("t1", "x"));
    const run = w.hook("t1"); // 认领了，没 commit（hook 崩了）
    expect(run.out).not.toBe("");
    w.setWaiting("t1", true);
    await w.mb.flush("t1");
    expect(w.delivered).toEqual([]);
    const dir = join(w.root, "t1");
    const [taken] = readdirSync(dir);
    const old = (w.now() - TAKEN_STALE_MS - 1000) / 1000;
    utimesSync(join(dir, taken), old, old);
    await w.mb.flush("t1");
    expect(w.delivered).toHaveLength(1);
  });

  it("a reply whose turn ended without Stop still comes back: the tick checks open heads that owe a reply, so the screen evidence heals them (BTL-279 review)", async () => {
    const w = world();
    w.add("boss", false);
    w.add("t1", true);
    w.add("t2", true);
    w.replies.set("t1", { id: "r0", text: "old", at: w.now() - 10 });
    const { id } = w.mb.send(msg("t1", "question"));
    const other = w.mb.send(msg("t2", "question for one that gets closed"));
    await flushPromises();
    expect(w.repo.get(id)?.status).toBe("delivered");
    expect(w.repo.get(other.id)?.status).toBe("delivered");
    // 它因为这条开始干活，写完回复，但 Stop 没来：记录一直说在干活，也没有别的消息排给它。
    w.setWaiting("t1", false);
    // t2 也在等回复，但终端关了（休眠）。
    w.setWaiting("t2", false);
    w.terms.delete("t2");
    w.hibernated.add("t2");
    w.tick(5000);
    w.replies.set("t1", { id: "r1", text: "answer", at: w.now() });
    w.healOnCheck.add("t1");
    w.checked.length = 0;
    w.tick(10_000);
    await w.mb.tick();
    await new Promise((r) => setTimeout(r, 0));
    await flushPromises();
    expect(w.repo.get(id)).toMatchObject({ status: "replied", replyText: "answer" });
    expect(w.repo.queued().filter((m) => m.kind === "reply")).toMatchObject([{ toSession: "boss", fromSession: "t1" }]);
    // 关着的不为查回复去看：guard 会去叫醒休眠的。
    expect(w.checked).not.toContain("t2");
    expect(w.woken).not.toContain("t2");
  });

  it("a reply still comes back when the answering turn lost both UserPromptSubmit and Stop: the record says waiting all along, the transcript says the turn ended (BTL-279 review)", async () => {
    const w = world();
    w.add("boss", false);
    w.add("e", true);
    w.replies.set("e", { id: "r0", text: "old", at: w.now() - 10 });
    const { id } = w.mb.send(msg("e", "please do X"));
    await flushPromises();
    expect(w.repo.get(id)?.status).toBe("delivered");
    // UserPromptSubmit 丢了：记录一直是贴之前的「在等」。那一轮跑完了、写了回复，Stop 也丢了。
    w.tick(60_000);
    // 一轮还开着时的中间话不算回复。
    w.replies.set("e", { id: "r1", text: "working on X", at: w.now() });
    w.tick(10_000);
    await w.mb.tick();
    await flushPromises();
    expect(w.repo.get(id)?.status).toBe("delivered");
    w.replies.set("e", { id: "r2", text: "done X", at: w.now() });
    w.turnClosed.add("e");
    w.tick(10_000);
    await w.mb.tick();
    await flushPromises();
    expect(w.repo.get(id)).toMatchObject({ status: "replied", replyText: "done X" });
    expect(w.repo.queued().filter((m) => m.kind === "reply")).toMatchObject([{ toSession: "boss", fromSession: "e" }]);
  });

  it("the reply to a delivered message still comes back while another message for that head stays held (third review)", async () => {
    const w = world();
    w.add("boss", false);
    w.add("e", true);
    w.replies.set("e", { id: "r0", text: "old", at: w.now() - 10 });
    const { id } = w.mb.send(msg("e", "please do X"));
    await flushPromises();
    expect(w.repo.get(id)?.status).toBe("delivered");
    // 之后它在问用户：Shipherd 别的消息被「需要你」挡着，一直排着。
    w.needsYou.add("e");
    const held = w.mb.send({ kind: "ci", from: null, to: "e", featureId: 1, body: "CI is red" });
    await flushPromises();
    expect(w.repo.get(held.id)?.status).toBe("queued");
    // 那一轮的 UserPromptSubmit 和 Stop 都丢了，transcript 显示已经结束。
    w.tick(30_000);
    w.replies.set("e", { id: "r2", text: "done X", at: w.now() });
    w.turnClosed.add("e");
    w.tick(10_000);
    await w.mb.tick();
    await flushPromises();
    expect(w.repo.get(held.id)?.status).toBe("queued");
    expect(w.repo.get(id)).toMatchObject({ status: "replied", replyText: "done X" });
  });

  it("a waiting head whose transcript shows an ended turn but whose last reply predates the delivery is not answered by it (BTL-279 review)", async () => {
    const w = world();
    w.add("boss", false);
    w.add("e", true);
    w.replies.set("e", { id: "r0", text: "old", at: w.now() - 10 });
    w.turnClosed.add("e");
    const { id } = w.mb.send(msg("e", "please do X"));
    await flushPromises();
    for (let i = 0; i < 3; i++) {
      w.tick(10_000);
      await w.mb.tick();
      await flushPromises();
    }
    expect(w.repo.get(id)?.status).toBe("delivered");
    expect(w.repo.queued()).toEqual([]);
  });

  it("a head that stopped after the delivery is not probed again: the Stop already checked for the reply (BTL-279 review)", async () => {
    const w = world();
    w.add("boss", false);
    w.add("e", true);
    w.replies.set("e", { id: "r0", text: "old", at: w.now() - 10 });
    w.turnClosed.add("e");
    const { id } = w.mb.send(msg("e", "please do X"));
    await flushPromises();
    w.tick(10_000);
    await w.mb.stopped("e");
    await flushPromises();
    const reads = w.replyReads.filter((h) => h === "e").length;
    expect(reads).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) {
      w.tick(10_000);
      await w.mb.tick();
      await flushPromises();
    }
    expect(w.replyReads.filter((h) => h === "e").length).toBe(reads);
    expect(w.repo.get(id)?.status).toBe("delivered");
  });

  it("probes a head that owes a reply on every tick for ten minutes after the delivery, then backs off to at most every five minutes; a new delivery starts over (BTL-279 review)", async () => {
    const w = world();
    w.add("boss", false);
    w.add("t1", true);
    w.mb.send(msg("t1", "question"));
    await flushPromises();
    const deliveredAt = w.now();
    // 它在干活，回复一直没来：每个 tick 记录说在干活，probe 过 guard（guard 挡住：busy）。
    w.setWaiting("t1", false);
    const probes: number[] = [];
    const step = 5_000;
    for (let t = step; t <= PROBE_DENSE_MS + 30 * 60_000; t += step) {
      w.tick(step);
      w.checked.length = 0;
      await w.mb.tick();
      if (w.checked.includes("t1")) probes.push(w.now() - deliveredAt);
    }
    const dense = probes.filter((x) => x < PROBE_DENSE_MS);
    expect(dense).toHaveLength(PROBE_DENSE_MS / step - 1);
    const gaps = probes.slice(dense.length).map((x, i) => x - probes[dense.length - 1 + i]);
    // 间隔一次翻一倍（按 tick 取整），最长 5 分钟。
    expect(gaps.slice(0, 5)).toEqual([PROBE_FIRST_GAP_MS, 2 * PROBE_FIRST_GAP_MS, 4 * PROBE_FIRST_GAP_MS, 8 * PROBE_FIRST_GAP_MS, PROBE_MAX_GAP_MS]);
    expect(Math.max(...gaps)).toBe(PROBE_MAX_GAP_MS);
    expect(gaps.slice(4).every((g) => g === PROBE_MAX_GAP_MS)).toBe(true);
    // 又送到一条等回复的：从头每个 tick 看。
    w.setWaiting("t1", true);
    w.mb.send(msg("t1", "another question"));
    await flushPromises();
    w.setWaiting("t1", false);
    let again = 0;
    for (let i = 0; i < 3; i++) {
      w.tick(step);
      w.checked.length = 0;
      await w.mb.tick();
      if (w.checked.includes("t1")) again++;
    }
    expect(again).toBe(3);
  });

  it("an old turn's reply written while deliver waited for the input box is the baseline, not the reply to this message (BTL-279 review)", async () => {
    const w = world();
    w.add("boss", false);
    w.add("t1", true);
    w.replies.set("t1", { id: "r0", text: "old", at: w.now() - 10 });
    // 等输入框的时候（最多一分钟），旧的那一轮写完了它的最后一段话，然后才贴进去。
    w.whileWaiting.run = () => {
      w.tick(30_000);
      w.replies.set("t1", { id: "r1", text: "the old turn's last words", at: w.now() });
      w.tick(1);
    };
    const { id } = w.mb.send(msg("t1", "question"));
    await flushPromises();
    expect(w.repo.get(id)).toMatchObject({ status: "delivered", baseReplyId: "r1", deliveredAt: w.now() });
    // 对方因为这条停下来，最后一条回复还是旧的 r1：不算回复。
    await w.mb.stopped("t1");
    expect(w.repo.get(id)?.status).toBe("delivered");
    expect(w.repo.queued()).toEqual([]);
  });

  it("interrupt presses Esc on a busy target and types the message in, keeping it off the hook's path", async () => {
    const w = world();
    w.add("t1", false);
    w.mb.send(msg("t1", "stop that", { interrupt: true }));
    expect(w.interrupts).toEqual(["t1"]);
    await flushPromises();
    await flushPromises();
    expect(w.delivered[0].text).toContain("stop that");
    expect(w.repo.recent({ featureId: 1 }, 1)[0]).toMatchObject({ status: "delivered", via: "input", interrupt: true });
  });

  it("records the reply when the target stops with a new last reply and queues it back to the sender", async () => {
    const w = world();
    w.add("boss", false);
    w.add("t1", true);
    w.replies.set("t1", { id: "r0", text: "old", at: w.now() - 10 });
    const { id } = w.mb.send(msg("t1", "question"));
    await flushPromises();
    expect(w.repo.get(id)).toMatchObject({ status: "delivered", baseReplyId: "r0" });
    // 停下来时最后一条回复还是送之前的那条：不算。
    await w.mb.stopped("t1");
    expect(w.repo.get(id)?.status).toBe("delivered");
    w.tick(1000);
    w.replies.set("t1", { id: "r1", text: "answer", at: w.now() });
    await w.mb.stopped("t1");
    expect(w.repo.get(id)).toMatchObject({ status: "replied", replyText: "answer" });
    const back = w.repo.queued();
    expect(back).toMatchObject([{ kind: "reply", toSession: "boss", fromSession: "t1" }]);
    expect(back[0].body).toContain("answer");
    // 24 小时后不再等。
    const late = w.mb.send(msg("t1", "q2"));
    await flushPromises();
    w.tick(REPLY_WAIT_MS + 1);
    w.replies.set("t1", { id: "r2", text: "late", at: w.now() });
    await w.mb.stopped("t1");
    expect(w.repo.get(late.id)?.status).toBe("delivered");
  });

  it("a target that replies and stops before the delivery is recorded still counts as replied", async () => {
    const w = world();
    w.add("boss", false);
    w.add("t1", true);
    w.replies.set("t1", { id: "r0", text: "old", at: w.now() - 10 });
    // 假 claude 那样的很短一轮：送进去的同时已经回完、停下了，送达的记账在那之后。
    w.deliver.mockImplementationOnce(async (term, text) => {
      w.delivered.push({ term, text });
      w.tick(50);
      w.replies.set("t1", { id: "r1", text: "fast answer", at: w.now() });
      await w.mb.stopped("t1");
      w.tick(50);
      return "sent";
    });
    const { id } = w.mb.send(msg("t1", "question"));
    await flushPromises();
    await flushPromises();
    expect(w.repo.get(id)).toMatchObject({ status: "replied", replyText: "fast answer" });
    expect(w.repo.queued()).toMatchObject([{ kind: "reply", toSession: "boss" }]);
  });

  it("calls the handler for the message's ref prefix once it is delivered", async () => {
    const w = world();
    w.add("t1", true);
    const seen: string[] = [];
    w.mb.on("answer", (m) => seen.push(m.ref!));
    w.mb.send({ ...msg("t1", "a"), kind: "answer", ref: "answer:7" });
    await flushPromises();
    expect(seen).toEqual(["answer:7"]);
  });

  it("a second send with the same ref replaces the queued one", () => {
    const w = world();
    w.add("t1", false);
    w.mb.send({ ...msg("t1", "first"), kind: "answer", ref: "answer:7" });
    w.mb.send({ ...msg("t1", "second"), kind: "answer", ref: "answer:7" });
    const files = w.dirFiles("t1")!;
    expect(files).toHaveLength(1);
    expect(readFileSync(join(w.root, "t1", files[0]), "utf8")).toContain("second");
  });

  it("notes the age of a message that waited more than ten minutes", async () => {
    const w = world();
    w.add("t1", false);
    w.mb.send(msg("t1", "old news"));
    w.tick(AGE_NOTE_MS + 60_000);
    w.setWaiting("t1", true);
    await w.mb.stopped("t1");
    expect(w.delivered[0].text).toMatch(/11 分钟前|11 min ago/);
  });

  it("rebuild and tick drop projections of closed terminals but keep the messages, and record .done files first", async () => {
    const w = world();
    w.add("t1", false);
    w.add("t2", false);
    w.mb.send(msg("t1", "a"));
    w.mb.send(msg("t2", "b"));
    w.hook("t2").commit();
    w.terms.delete("t1");
    w.terms.delete("t2");
    w.mb.rebuild();
    expect(readdirSync(w.root)).toEqual([]);
    expect(w.repo.queued().map((m) => m.body)).toEqual(["a"]);
    w.terms.set("t1", "t1");
    await w.mb.tick();
    expect(w.dirFiles("t1")).toHaveLength(1);
    w.tick(MESSAGE_KEEP_MS + 1);
    await w.mb.tick();
    expect(w.repo.queued()).toEqual([]);
  });

  it("a stale .main left by a crash is put back", () => {
    const w = world();
    w.add("t1", false);
    w.mb.send(msg("t1", "a"));
    const dir = join(w.root, "t1");
    const [n] = readdirSync(dir);
    renameSync(join(dir, n), join(dir, `${n}.main`));
    const old = (w.now() - 6 * 60_000) / 1000;
    utimesSync(join(dir, `${n}.main`), old, old);
    w.mb.sweep("t1");
    expect(readdirSync(dir)).toEqual([n]);
  });

  it("lists messages for a feature or for Shipherd's sessions with readable names", () => {
    const w = world();
    w.add("t1", false);
    w.mb.send(msg("t1", "x"));
    w.mb.send({ ...msg("t1", "y"), from: "shipherd", featureId: null, kind: "shipherd" });
    expect(w.mb.views({ featureId: 1 }, []).map((v) => [v.from, v.to, v.status, v.text])).toEqual([["S(boss)", "S(t1)", "queued", "x"]]);
    expect(w.mb.views({ shipherd: true }, ["shipherd"]).map((v) => v.text)).toEqual(["y"]);
  });

  it("asks a session without a terminal to wake for a message, but not for a convention alone", async () => {
    const w = world();
    w.add("z", true, false);
    w.mb.send({ kind: "convention", from: "a", to: "z", featureId: 1, body: "约定" });
    await flushPromises();
    expect(w.woken).toEqual([]);
    expect(w.mb.send(msg("z", "醒醒")).state).toBe("closed");
    await flushPromises();
    expect(w.woken).toEqual(["z"]);
    expect(w.repo.queued()).toHaveLength(2);
  });

  it("wakes a closed session for an important fact only (BTL-272)", async () => {
    const w = world();
    w.add("z", true, false);
    w.mb.send({ kind: "fact", from: "a", to: "z", featureId: 1, body: "顺带知道一下", meta: { item: 1 } });
    await flushPromises();
    expect(w.woken).toEqual([]);
    w.mb.send({ kind: "fact", from: "a", to: "z", featureId: 1, body: "BTL-12 不做了", meta: { item: 2, wake: true } });
    await flushPromises();
    expect(w.woken).toEqual(["z"]);
  });

  it("tells the delivered callback about each message it delivers (BTL-256)", async () => {
    const w = world();
    w.add("t1", true);
    const a = w.mb.send(msg("t1", "one"));
    const b = w.mb.send(msg("t1", "two"));
    await flushPromises();
    await w.mb.flush("t1");
    expect(w.deliveredMsgs).toEqual([{ id: a.id, via: "input" }, { id: b.id, via: "input" }]);
  });
});

describe("pruning old messages (BTL-275)", () => {
  it("deletes at most once every PRUNE_EVERY_MS instead of on every 10 s tick, and still deletes what is old", async () => {
    const w = world();
    w.add("t1", false);
    const prune = vi.spyOn(w.repo, "prune");
    await w.mb.tick();
    expect(prune).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      w.tick(10_000);
      await w.mb.tick();
    }
    expect(prune).toHaveBeenCalledTimes(1);
    w.mb.send(msg("t1", "old"));
    w.tick(MESSAGE_KEEP_MS + PRUNE_EVERY_MS);
    await w.mb.tick();
    expect(prune).toHaveBeenCalledTimes(2);
    expect(w.repo.recent({ sessions: ["t1"] }, 10)).toEqual([]);
  });
});

/** 空闲时 mailbox.tick 的开销（BTL-275 基准，只在 SHIPHERD_PERF_BENCH=1 时跑）：20 个开着的终端、信箱都空着。 */
describe.skipIf(process.env.SHIPHERD_PERF_BENCH !== "1")("idle tick bench (BTL-275)", () => {
  it("an idle tick with 20 open terminals", async () => {
    const w = world();
    for (let i = 0; i < 20; i++) w.add(`t${i}`, false);
    const prune = vi.spyOn(w.repo, "prune");
    await w.mb.tick();
    prune.mockClear();
    const n = 60; // 10 分钟（每 10 秒一次）
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      w.tick(10_000);
      await w.mb.tick();
    }
    console.log(`[idle-bench] mailbox tick: ${((performance.now() - t0) / n).toFixed(2)} ms per tick, ${prune.mock.calls.length} prune DELETEs in ${n} ticks (10 min)`);
  });
});

describe("Mailbox: getting into an idle session (BTL-269)", () => {
  it("deliver now of the coordinator's answer (answers: true) while it needs you says it answers the question, and closes it", async () => {
    const w = world();
    w.add("t1", false);
    w.busyReason.set("t1", "unsure");
    w.needsYou.add("t1");
    w.awaiting.set("t1", { asks: [{ id: 5, question: "which one?", at: w.now() - 1 }], text: null });
    w.controllerOf.set("t1", "coord");
    const { id } = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "[wrapped] pick 2", meta: { answers: true, text: "pick 2" } });
    await flushPromises();
    expect(await w.mb.deliverNow(id)).toEqual({ delivered: true, reason: null });
    expect(w.delivered[0].text).toContain(M().mailboxAnswersQuestion("which one?"));
    expect(w.coordinatorAnswered).toEqual([{ head: "t1", asks: [5], answer: "pick 2", by: "S(coord)", queuedAt: w.repo.get(id)!.queuedAt }]);
  });

  it("A1: deliver now while it only just stopped (not judged yet) goes in as a plain message: no answer note, nothing marked answered", async () => {
    const w = world();
    w.add("t1", false);
    w.busyReason.set("t1", "unsure");
    w.needsYou.add("t1");
    w.awaiting.set("t1", null);
    w.controllerOf.set("t1", "coord");
    const { id } = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "pick 2", meta: { answers: true, text: "pick 2" } });
    await flushPromises();
    expect(await w.mb.deliverNow(id)).toEqual({ delivered: true, reason: null });
    expect(w.delivered[0].text).not.toContain(M().mailboxNotAnAnswer);
    expect(w.delivered[0].text).not.toContain("替用户答");
    // 越过了「还在判断」：和 flush 判断太久时一样，注明不是用户的回答（BTL-279 复核建议 5）。
    expect(w.delivered[0].text).toContain(M().mailboxNotUserAnswer);
    expect(w.coordinatorAnswered).toEqual([]);
  });

  it("deliver now past needs_you marks Shipherd's own notice as not the user's answer; with nothing holding it, no note (BTL-279 review suggestion 5)", async () => {
    const w = world();
    w.add("t1", true);
    w.needsYou.add("t1");
    w.awaiting.set("t1", { asks: [{ id: 5, question: "which one?", at: w.now() - 1 }], text: null });
    const held = w.mb.send({ kind: "ci", from: null, to: "t1", featureId: 1, body: "CI is red" });
    await flushPromises();
    expect(w.repo.get(held.id)!.status).toBe("queued");
    expect(await w.mb.deliverNow(held.id)).toEqual({ delivered: true, reason: null });
    expect(w.delivered.at(-1)!.text).toContain(M().mailboxNotUserAnswer);
    expect(w.delivered.at(-1)!.text).toContain("CI is red");

    const v = world();
    v.add("t1", true);
    v.typing.add("t1");
    const plain = v.mb.send({ kind: "ci", from: null, to: "t1", featureId: 1, body: "CI is red" });
    await flushPromises();
    expect(v.repo.get(plain.id)!.status).toBe("queued");
    expect(await v.mb.deliverNow(plain.id)).toEqual({ delivered: true, reason: null });
    expect(v.delivered.at(-1)!.text).not.toContain(M().mailboxNotUserAnswer);
  });

  it("deliver now of the user's own ask_user answer held as unsure is not marked as not the user's answer, also with a notice queued behind it (third review)", async () => {
    const w = world();
    w.add("t1", false);
    w.busyReason.set("t1", "unsure");
    w.needsYou.add("t1");
    w.awaiting.set("t1", { asks: [{ id: 7, question: "which one?", at: w.now() - 1 }], text: null });
    const { id } = w.mb.send({ ...msg("t1", "answer: B"), kind: "answer", ref: "answer:7" });
    w.mb.send({ kind: "ci", from: null, to: "t1", featureId: 1, body: "CI is red" });
    await flushPromises();
    expect(w.repo.get(id)!.status).toBe("queued");
    expect(await w.mb.deliverNow(id)).toEqual({ delivered: true, reason: null });
    const typed = w.delivered.map((d) => d.text).join("\n");
    expect(typed).toContain("answer: B");
    // 和 flush 一样：排着 session 等的回答时不越过「需要你」，什么都不注明。
    expect(typed).not.toContain(M().mailboxNotUserAnswer);
  });

  it("a coordinator waiting on the user still gets its sessions' reports and the replies to what it sent, each marked as not the user's answer (BTL-279)", async () => {
    const w = world();
    w.add("coord", true);
    w.needsYou.add("coord");
    w.subordinates.set("coord", new Set(["t1"]));
    const report = w.mb.send({ kind: "report", from: "t1", to: "coord", featureId: 1, body: "PR #12 is open" });
    const reply = w.mb.send({ kind: "reply", from: "t2", to: "coord", featureId: 1, body: "【回复】done" });
    // 不是它管的 session 的汇报、Shipherd 自己的 CI 通知照样等用户回答完（计划 14）。
    const stranger = w.mb.send({ kind: "report", from: "x9", to: "coord", featureId: 1, body: "not mine" });
    const ci = w.mb.send({ kind: "ci", from: null, to: "coord", featureId: 1, body: "CI failed" });
    await flushPromises();
    await w.mb.flush("coord");
    const typedIn = w.delivered.map((d) => d.text).join("\n");
    expect(typedIn).toContain("PR #12 is open");
    expect(typedIn).toContain("【回复】done");
    expect(typedIn.split(M().mailboxNotUserAnswer)).toHaveLength(3);
    expect(typedIn).not.toContain("not mine");
    expect(typedIn).not.toContain("CI failed");
    expect(w.repo.get(report.id)!.status).toBe("delivered");
    expect(w.repo.get(reply.id)!.status).toBe("delivered");
    expect(w.repo.get(stranger.id)!.blockedReason).toBe("needs_you");
    expect(w.repo.get(ci.id)!.blockedReason).toBe("needs_you");
  });

  it("not waiting on the user: reports go in without the note (BTL-279)", async () => {
    const w = world();
    w.add("coord", true);
    w.subordinates.set("coord", new Set(["t1"]));
    w.mb.send({ kind: "report", from: "t1", to: "coord", featureId: 1, body: "PR #12 is open" });
    await flushPromises();
    await w.mb.flush("coord");
    expect(w.delivered[0].text).not.toContain(M().mailboxNotUserAnswer);
  });

  it("judging that never settles holds the coordinator's message only so long; then it goes in marked as not the user's answer (BTL-279)", async () => {
    const w = world();
    w.add("t1", true);
    w.needsYou.add("t1");
    w.awaiting.set("t1", null);
    w.controllerOf.set("t1", "coord");
    const { id } = w.mb.send({ kind: "shipherd", from: "coord", to: "t1", featureId: 1, body: "status?" });
    const ci = w.mb.send({ kind: "ci", from: null, to: "t1", featureId: 1, body: "CI failed" });
    await flushPromises();
    w.tick(JUDGING_HOLD_MS - 1000);
    await w.mb.tick();
    expect(w.delivered).toEqual([]);
    expect(w.repo.get(id)!.blockedReason).toBe("judging");
    w.tick(1000);
    await w.mb.tick();
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0].text).toContain("status?");
    expect(w.delivered[0].text).toContain(M().mailboxNotUserAnswer);
    expect(w.delivered[0].text).not.toContain(M().mailboxNotAnAnswer);
    expect(w.coordinatorAnswered).toEqual([]);
    expect(w.repo.get(ci.id)!.status).toBe("queued");
  });

  it("one session slow to take its input does not hold up the others in the same tick, and the next tick does not type into it twice (BTL-279)", async () => {
    const w = world();
    w.add("slow", false);
    w.add("fast", false);
    w.mb.send(msg("slow", "for slow"));
    w.mb.send(msg("fast", "for fast"));
    await flushPromises();
    let release: (r: DeliverResult) => void = () => {};
    w.deliver.mockImplementationOnce(async (term, text) => {
      w.delivered.push({ term, text });
      return new Promise<DeliverResult>((r) => (release = r));
    });
    w.setWaiting("slow", true);
    w.setWaiting("fast", true);
    const first = w.mb.tick();
    await flushPromises();
    // slow 的输入框一直没就绪（deliver 最多等 1 分钟）：fast 不用等它。
    expect(w.delivered.map((d) => d.term).sort()).toEqual(["fast", "slow"]);
    const second = w.mb.tick();
    await flushPromises();
    expect(w.delivered.filter((d) => d.term === "slow")).toHaveLength(1);
    release("sent");
    await first;
    await second;
    expect(w.repo.queued()).toEqual([]);
  });

  it("one head's flush throwing does not cost the others their delivery or the tick its reply check; the failure is logged per head (BTL-279 second review)", async () => {
    const w = world();
    w.add("bad", false);
    w.add("good", false);
    w.add("owes", true);
    w.mb.send(msg("bad", "for bad"));
    w.mb.send(msg("good", "for good"));
    const asked = w.mb.send(msg("owes", "question"));
    await flushPromises();
    expect(w.repo.get(asked.id)?.status).toBe("delivered");
    w.setWaiting("owes", false);
    w.checked.length = 0;
    const real = w.mb.flush.bind(w.mb);
    vi.spyOn(w.mb, "flush").mockImplementation((h) => (h === "bad" ? Promise.reject(new Error("boom")) : real(h)));
    w.setWaiting("good", true);
    await w.mb.tick();
    await flushPromises();
    expect(w.delivered.some((d) => d.term === "good" && d.text.includes("for good"))).toBe(true);
    expect(w.checked).toContain("owes");
    expect(w.logs.some((l) => l.includes("flushing bad failed"))).toBe(true);
    expect(w.logs.some((l) => l.includes("tick failed"))).toBe(false);
  });

  it("a reply to a global control that was closed for a newer one goes to the one now open; the requestId stays (BTL-279)", async () => {
    const w = world();
    w.add("t1", false);
    w.add("old", true);
    const { id } = w.mb.send({ kind: "shipherd", from: "old", to: "t1", featureId: 1, body: "look at the mailbox" });
    w.setWaiting("t1", true);
    await w.mb.flush("t1");
    expect(w.repo.get(id)!.status).toBe("delivered");
    // 用户关掉了旧的全局总控、开了一个新的（不是换新，没有 replacedBy）。
    w.terms.delete("old");
    w.add("new", true);
    w.successors.set("old", "new");
    w.replies.set("t1", { id: "r1", text: "done, PR #5", at: w.now() + 10 });
    w.tick(20);
    await w.mb.stopped("t1");
    await flushPromises();
    const got = w.delivered.filter((d) => d.term === "new").map((d) => d.text).join("\n");
    expect(got).toContain("done, PR #5");
    expect(got).toContain(id);
    expect(w.repo.get(id)!.status).toBe("replied");
    expect(w.repo.queued()).toEqual([]);
    // 只搬回复和汇报：发给旧总控的别的消息（CI 之类）留在它自己的信箱。
    const ci = w.mb.send({ kind: "ci", from: null, to: "old", featureId: 1, body: "CI red" });
    await flushPromises();
    expect(w.repo.get(ci.id)!.toSession).toBe("old");
    expect(w.repo.get(ci.id)!.status).toBe("queued");
  });

  it("the reply keeps its requestId when the recipient was replaced (refresh, resume under a new id) and the sender too (BTL-279)", async () => {
    const w = world();
    w.add("t1", true);
    w.add("coord", true);
    const { id } = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "do it" });
    await flushPromises();
    expect(w.repo.get(id)!.status).toBe("delivered");
    // 收件人换新了（/handoff + /clear，或者 --resume 换了 id）：新 head 是 t2。
    w.terms.delete("t1");
    w.sessions.get("t1")!.replacedBy = "t2";
    w.sessions.set("t2", { id: "t2", waitingForInput: true });
    w.terms.set("t2", "t2");
    // 发件的总控也换新了：coord → coord2。
    w.terms.delete("coord");
    w.sessions.get("coord")!.replacedBy = "coord2";
    w.sessions.set("coord2", { id: "coord2", waitingForInput: true });
    w.terms.set("coord2", "coord2");
    w.replies.set("t2", { id: "r9", text: "finished it", at: w.now() + 5 });
    w.tick(10);
    await w.mb.stopped("t2");
    await flushPromises();
    expect(w.repo.get(id)!.status).toBe("replied");
    const got = w.delivered.filter((d) => d.term === "coord2").map((d) => d.text).join("\n");
    expect(got).toContain("finished it");
    expect(got).toContain(id);
  });

  it("readdressing to the successor does not hold up the closed control's own mail: it is blocked and woken before the paste into the successor (BTL-279 review)", async () => {
    const w = world();
    w.add("old", false, false);
    w.add("new", true);
    const reply = w.mb.send({ kind: "reply", from: "t1", to: "old", featureId: 1, body: "【回复】x" });
    const inst = w.mb.send(msg("old", "an instruction for the old control"));
    await flushPromises();
    // 用户这时另开了一个接替它的。
    w.successors.set("old", "new");
    w.woken.length = 0;
    w.repo.setBlocked([inst.id], null, w.now());
    // 往接替的那个里贴要等（最多一分钟）：这期间旧的那个的指示已经记成 closed、叫醒了。
    const seen: { blocked: string | null; woken: boolean }[] = [];
    w.whileWaiting.run = () => seen.push({ blocked: w.repo.get(inst.id)!.blockedReason, woken: w.woken.includes("old") });
    await w.mb.flush("old");
    expect(seen).toEqual([{ blocked: "closed", woken: true }]);
    expect(w.repo.get(reply.id)).toMatchObject({ status: "delivered", toSession: "new" });
    expect(w.repo.get(inst.id)).toMatchObject({ status: "queued", toSession: "old" });
  });

  it("Deliver now on a reply to a closed control says it went in when it was readdressed to the successor and delivered (BTL-279 review)", async () => {
    const w = world();
    w.add("old", false, false);
    w.add("new", true);
    const { id } = w.mb.send({ kind: "reply", from: "t1", to: "old", featureId: 1, body: "【回复】x" });
    await flushPromises();
    w.successors.set("old", "new");
    expect(await w.mb.deliverNow(id)).toEqual({ delivered: true, reason: null });
    expect(w.repo.get(id)).toMatchObject({ status: "delivered", toSession: "new" });
  });

  it("Deliver now on a reply readdressed to a busy successor reports why the successor holds it, not that the old control is closed (BTL-279 review)", async () => {
    const w = world();
    w.add("old", false, false);
    // 接替的那个开着，但在干活（turn）。
    w.add("new", false);
    const { id } = w.mb.send({ kind: "reply", from: "t1", to: "old", featureId: 1, body: "【回复】x" });
    await flushPromises();
    w.successors.set("old", "new");
    expect(await w.mb.deliverNow(id)).toEqual({ delivered: false, reason: "turn" });
    expect(w.repo.get(id)).toMatchObject({ status: "queued", toSession: "new", blockedReason: "turn" });
  });

  it("a reply to a closed control is not readdressed to a successor that is closed too: it waits for its own and wakes it (BTL-279 review)", async () => {
    const w = world();
    w.add("old", false, false);
    w.add("new", false, false);
    w.successors.set("old", "new");
    const { id } = w.mb.send({ kind: "reply", from: "t1", to: "old", featureId: 1, body: "【回复】x" });
    await flushPromises();
    expect(w.repo.get(id)).toMatchObject({ status: "queued", toSession: "old", blockedReason: "closed" });
    expect(w.woken).toContain("old");
    expect(w.woken).not.toContain("new");
  });

  it("a reply to a hibernated control stays its own even when another control of the epic is open: it is woken, not readdressed (BTL-279 review)", async () => {
    const w = world();
    w.add("old", false, false);
    w.add("new", true);
    w.hibernated.add("old");
    w.successors.set("old", "new");
    const { id } = w.mb.send({ kind: "reply", from: "t1", to: "old", featureId: 1, body: "【回复】x" });
    await flushPromises();
    expect(w.repo.get(id)).toMatchObject({ status: "queued", toSession: "old", blockedReason: "hibernated" });
    expect(w.woken).toContain("old");
    expect(w.delivered).toEqual([]);
  });

  it("a reply to a closed control with no one taking over waits for it and asks to wake it (BTL-279)", async () => {
    const w = world();
    w.add("coord", false, false);
    const { id } = w.mb.send({ kind: "reply", from: "t1", to: "coord", featureId: 1, body: "【回复】x" });
    await flushPromises();
    expect(w.repo.get(id)).toMatchObject({ status: "queued", toSession: "coord", blockedReason: "closed" });
    expect(w.woken).toContain("coord");
  });

  it("unsure for UNSURE_DELIVER_MS: it goes in anyway (the screen shows an empty box, nothing running); turn never does (BTL-279)", async () => {
    const w = world();
    w.add("t1", false);
    w.busyReason.set("t1", "unsure");
    const { id } = w.mb.send(msg("t1", "from the global control"));
    await flushPromises();
    w.tick(UNSURE_DELIVER_MS - 1000);
    await w.mb.tick();
    expect(w.delivered).toEqual([]);
    expect(w.repo.get(id)!.blockedReason).toBe("unsure");
    w.tick(1000);
    await w.mb.tick();
    expect(w.delivered).toHaveLength(1);
    expect(w.repo.get(id)!.status).toBe("delivered");
    expect(w.lenientRechecks.at(-1)).toBe(true);
    // 屏幕上看得出在跑（turn）：多久都不硬送，hook 在下一次工具调用时带进去。
    const v = world();
    v.add("t2", false);
    const b = v.mb.send(msg("t2", "x"));
    await flushPromises();
    v.tick(60 * 60_000);
    await v.mb.tick();
    expect(v.delivered).toEqual([]);
    expect(v.repo.get(b.id)!.blockedReason).toBe("turn");
  });

  it("unsure: a newer message queued behind an old one does not restart the clock; the oldest wait counts (BTL-279 second review)", async () => {
    const w = world();
    w.add("t1", false);
    w.busyReason.set("t1", "unsure");
    w.mb.send(msg("t1", "old"));
    await flushPromises();
    w.tick(UNSURE_DELIVER_MS - 1000);
    await w.mb.tick();
    w.mb.send(msg("t1", "new"));
    await flushPromises();
    expect(w.delivered).toEqual([]);
    w.tick(1000);
    await w.mb.tick();
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0].text).toContain("old");
    expect(w.delivered[0].text).toContain("new");
  });

  it("A1: right after a stop, before the verdict, the coordinator's message waits as 'judging' and is not taken as an answer; once judged it goes in", async () => {
    const w = world();
    w.add("t1", true);
    w.needsYou.add("t1");
    w.awaiting.set("t1", null);
    w.controllerOf.set("t1", "coord");
    const { id } = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "pick 2", meta: { answers: true, text: "pick 2" } });
    await flushPromises();
    expect(w.delivered).toEqual([]);
    expect(w.repo.get(id)!.blockedReason).toBe("judging");
    expect(w.coordinatorAnswered).toEqual([]);
    // 判断完：不需要你。下一次 tick 当普通消息送，不加说明、也不去结束什么。
    w.needsYou.delete("t1");
    await w.mb.tick();
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0].text).toContain("pick 2");
    expect(w.delivered[0].text).not.toContain(M().mailboxNotAnAnswer);
    expect(w.coordinatorAnswered).toEqual([]);
    expect(w.repo.get(id)!.blockedReason).toBeNull();
  });

  it("A1: while it is still being judged, what the user typed in the conversation tab still goes in; only the coordinator's waits", async () => {
    const w = world();
    w.add("t1", false);
    w.controllerOf.set("t1", "coord");
    w.busyReason.set("t1", "unsure");
    const c = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "coord says", meta: { answers: true, text: "coord says" } });
    w.mb.send({ kind: "user", from: null, to: "t1", featureId: null, body: "user says" });
    await flushPromises();
    w.busyReason.delete("t1");
    w.setWaiting("t1", true);
    w.needsYou.add("t1");
    w.awaiting.set("t1", null);
    await w.mb.flush("t1");
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0].text).toContain("user says");
    expect(w.delivered[0].text).not.toContain("coord says");
    expect(w.repo.get(c.id)!.blockedReason).toBe("judging");
    expect(w.coordinatorAnswered).toEqual([]);
  });

  it("A2: a message queued before the question was asked never counts as its answer, even with answers: true", async () => {
    const w = world();
    w.add("t1", false);
    w.controllerOf.set("t1", "coord");
    w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "old plan", meta: { answers: true, text: "old plan" } });
    await flushPromises();
    w.tick(1000);
    // 之后它停下来问了一个问题。
    w.setWaiting("t1", true);
    w.needsYou.add("t1");
    w.awaiting.set("t1", { asks: [{ id: 7, question: "A or B?", at: w.now() }], text: { reason: "asks A or B", at: w.now() } });
    await w.mb.flush("t1");
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0].text).toContain(M().mailboxNotAnAnswer);
    expect(w.coordinatorAnswered).toEqual([]);
  });

  it("A2: if the user answers on the card while Shipherd waits for the input box, the 'answering for the user' note is not typed in; it goes in later without it (review 3, suggestion 2)", async () => {
    const w = world();
    w.add("t1", true);
    w.needsYou.add("t1");
    w.awaiting.set("t1", { asks: [{ id: 5, question: "which one?", at: w.now() - 1 }], text: null });
    w.controllerOf.set("t1", "coord");
    w.whileWaiting.run = () => {
      // 用户在卡片上答了：不再是没答的提问；「需要你」也解除了（卡片的回答会直接送）。
      w.awaiting.set("t1", { asks: [], text: null });
      w.needsYou.delete("t1");
    };
    const { id } = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "pick 2", meta: { answers: true, text: "pick 2" } });
    await flushPromises();
    expect(w.delivered).toEqual([]);
    expect(w.repo.get(id)!.status).toBe("queued");
    expect(w.coordinatorAnswered).toEqual([]);
    await w.mb.tick();
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0].text).toContain("pick 2");
    expect(w.delivered[0].text).not.toContain(M().mailboxAnswersQuestion("which one?"));
    expect(w.coordinatorAnswered).toEqual([]);
  });

  it("A2: answers with an id closes only that question", async () => {
    const w = world();
    w.add("t1", true);
    w.needsYou.add("t1");
    w.awaiting.set("t1", { asks: [{ id: 5, question: "first?", at: w.now() - 2 }, { id: 6, question: "second?", at: w.now() - 1 }], text: null });
    w.controllerOf.set("t1", "coord");
    w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "B", meta: { answers: 6, text: "B" } });
    await flushPromises();
    expect(w.delivered[0].text).toContain(M().mailboxAnswersQuestion("second?"));
    expect(w.delivered[0].text).not.toContain("first?");
    expect(w.coordinatorAnswered.map((c) => c.asks)).toEqual([[6]]);
  });

  it("waits 10 minutes, not 2, before a receipt when the only reason is that the turn is still running", async () => {
    const w = world();
    w.add("t1", false);
    w.add("coord", true);
    w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "x" });
    await flushPromises();
    w.tick(STUCK_RECEIPT_MS + 1000);
    await w.mb.tick();
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toEqual([]);
    expect(w.delivered).toEqual([]);
    w.tick(STUCK_TURN_RECEIPT_MS);
    await w.mb.tick();
    expect(w.delivered.map((d) => d.term)).toEqual(["coord"]);
  });

  it("records that typing it in timed out instead of keeping an older reason", async () => {
    const w = world();
    w.add("t1", false);
    w.mb.send(msg("t1", "x"));
    await flushPromises();
    expect(w.repo.queued()[0].blockedReason).toBe("turn");
    w.setWaiting("t1", true);
    w.failDeliver("timeout");
    await w.mb.flush("t1");
    expect(w.repo.queued()[0].blockedReason).toBe("deliver_failed");
  });

  it("A: a coordinator instruction that fails to go in does not close the question", async () => {
    const w = world();
    w.add("t1", true);
    w.needsYou.add("t1");
    w.awaiting.set("t1", { asks: [{ id: 5, question: "q", at: w.now() - 1 }], text: null });
    w.controllerOf.set("t1", "coord");
    w.failDeliver("timeout");
    w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "pick option 2", meta: { answers: true, text: "pick option 2" } });
    await flushPromises();
    expect(w.coordinatorAnswered).toEqual([]);
  });

  it("A: the user's own words while it needs you do not mark the question as answered by the coordinator", async () => {
    const w = world();
    w.add("t1", true);
    w.needsYou.add("t1");
    w.controllerOf.set("t1", "coord");
    w.mb.send({ kind: "user", from: null, to: "t1", featureId: 1, body: "my answer" });
    await flushPromises();
    expect(w.delivered).toHaveLength(1);
    expect(w.coordinatorAnswered).toEqual([]);
  });

  it("A: the session's own coordinator gets in while it needs you, with a note; someone else's instruction still waits", async () => {
    const w = world();
    w.add("t1", true);
    w.needsYou.add("t1");
    w.controllerOf.set("t1", "coord");
    w.mb.send({ kind: "instruction", from: "other", to: "t1", featureId: 1, body: "not yours" });
    await flushPromises();
    expect(w.delivered).toEqual([]);
    expect(w.repo.queued()[0]).toMatchObject({ blockedReason: "needs_you" });
    expect(w.coordinatorAnswered).toEqual([]);
    // A2：没带 answers 的照样送进去，但注明不是回答，提问留给用户。
    w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "unrelated note" });
    await flushPromises();
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0].text).toContain(M().mailboxNotAnAnswer);
    expect(w.coordinatorAnswered).toEqual([]);
    w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "pick option 2", meta: { answers: true, text: "pick option 2" } });
    await flushPromises();
    // 只送总控这一条（守卫看的是实际送的这一批），注明是在替用户回答；别人的那条接着等。
    expect(w.delivered).toHaveLength(2);
    expect(w.delivered[1].text).toContain("pick option 2");
    expect(w.delivered[1].text).toContain(M().mailboxAnswersQuestion("asked in text"));
    expect(w.delivered[1].text).not.toContain("not yours");
    expect(w.repo.queued().map((m) => m.body)).toEqual(["not yours"]);
    expect(w.repo.queued()[0].blockedReason).toBe("needs_you");
    // 用文字问的（没有 ask_user）：没有卡片要结束。
    expect(w.coordinatorAnswered).toEqual([]);
    // 不需要你的时候不加说明。
    w.needsYou.delete("t1");
    w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "next" });
    await flushPromises();
    expect(w.delivered.at(-1)!.text).not.toContain(M().mailboxNotAnAnswer);
    expect(w.delivered.at(-1)!.text).not.toContain("替用户答");
  });

  it("records why a message is blocked and since when; the reason changes only when it really changes, and each change is logged", async () => {
    const w = world();
    w.add("t1", false);
    w.busyReason.set("t1", "unsure");
    const { id } = w.mb.send(msg("t1", "hello"));
    await flushPromises();
    const first = w.repo.get(id)!;
    expect(first).toMatchObject({ blockedReason: "unsure", blockedSince: w.now() });
    expect(w.logs.filter((l) => l.includes("blocked (unsure)"))).toHaveLength(1);
    w.tick(10_000);
    await w.mb.tick();
    expect(w.repo.get(id)!.blockedSince).toBe(first.blockedSince);
    expect(w.logs.filter((l) => l.includes("blocked (unsure)"))).toHaveLength(1);
    w.busyReason.set("t1", "turn");
    w.tick(10_000);
    await w.mb.tick();
    expect(w.repo.get(id)).toMatchObject({ blockedReason: "turn", blockedSince: w.now() });
    expect(w.mb.pendingFor("t1")).toMatchObject({ queued: 1, reason: "turn", since: w.now() });
    expect(w.mb.views({ featureId: 1 }, [])[0].blocked).toEqual({ reason: "turn", since: new Date(w.now()).toISOString() });
    // 关着的终端也记原因。
    w.terms.delete("t1");
    await w.mb.tick();
    expect(w.repo.get(id)!.blockedReason).toBe("closed");
  });

  it("counts every real attempt that did not get a message in (a new reason, or a paste that did not go in), with its time and result; the message list and pendingView show them (BTL-279)", async () => {
    const w = world();
    w.add("t1", false);
    const { id } = w.mb.send(msg("t1", "hello"));
    await flushPromises();
    expect(w.repo.get(id)).toMatchObject({ attempts: 1, lastAttemptAt: w.now(), lastAttempt: "turn" });
    const firstNotices = w.messageNotices();
    w.tick(10_000);
    await w.mb.tick();
    w.tick(10_000);
    await w.mb.tick();
    // 原因没变、也没去贴的 tick 不算（BTL-279 review）：不写库、不通知，排一夜也不会涨到几千次。
    expect(w.repo.get(id)).toMatchObject({ attempts: 1, lastAttemptAt: w.now() - 20_000, lastAttempt: "turn", blockedSince: w.now() - 20_000 });
    expect(w.messageNotices()).toBe(firstNotices);
    // 等输入框超时、粘贴前复查没过、终端退出：真的去贴了，每次都算，原因相同也算。
    w.setWaiting("t1", true);
    w.failDeliver("timeout");
    w.tick(10_000);
    await w.mb.tick();
    expect(w.repo.get(id)).toMatchObject({ attempts: 2, lastAttempt: "deliver_failed" });
    expect(w.messageNotices()).toBe(firstNotices + 1);
    w.tick(10_000);
    await w.mb.tick();
    expect(w.repo.get(id)).toMatchObject({ attempts: 3, lastAttemptAt: w.now(), lastAttempt: "deliver_failed" });
    w.failDeliver("blocked");
    w.tick(10_000);
    await w.mb.tick();
    expect(w.repo.get(id)).toMatchObject({ attempts: 4, lastAttempt: "recheck" });
    w.failDeliver("exited");
    w.tick(10_000);
    await w.mb.tick();
    expect(w.repo.get(id)).toMatchObject({ attempts: 5, lastAttemptAt: w.now(), lastAttempt: "exited" });
    expect(w.mb.views({ featureId: 1 }, [])[0]).toMatchObject({ attempts: 5, lastAttemptAt: new Date(w.now()).toISOString(), lastAttempt: "exited" });
    expect(w.mb.pendingView("t1")).toMatchObject({ attempts: 5, lastAttemptAt: new Date(w.now()).toISOString() });
    // 送到了：次数留着。
    w.failDeliver("sent");
    w.tick(10_000);
    await w.mb.tick();
    expect(w.repo.get(id)).toMatchObject({ status: "delivered", attempts: 5 });
    expect(w.mb.views({ featureId: 1 }, [])[0]).toMatchObject({ status: "delivered", attempts: 5, blocked: null });
  });

  it("diagnostics lists every queued message with why it waits and how often it was tried, and recent ones with how they went in; never the text (BTL-279)", async () => {
    const w = world();
    w.add("t1", false);
    w.add("t2", true);
    const a = w.mb.send(msg("t1", "secret plan A"));
    const b = w.mb.send(msg("t2", "secret plan B"));
    await flushPromises();
    w.tick(10_000);
    await w.mb.tick();
    const d = w.mb.diagnostics();
    expect(d.queued).toEqual([
      expect.objectContaining({
        id: a.id, kind: "instruction", from: "boss", to: "t1", head: "t1", term: "t1", queuedAt: new Date(w.now() - 10_000).toISOString(),
        blockedReason: "turn", blockedSince: new Date(w.now() - 10_000).toISOString(), attempts: 1, lastAttemptAt: new Date(w.now() - 10_000).toISOString(), lastAttempt: "turn",
        stuckReceiptAt: null, inFlight: false,
      }),
    ]);
    expect(d.recent).toEqual(expect.arrayContaining([expect.objectContaining({ id: b.id, status: "delivered", via: "input", attempts: 0 })]));
    expect(d.inputting).toEqual([]);
    expect(JSON.stringify(d)).not.toContain("secret plan");
  });

  it("settle says delivered when it went in, and queued with the reason when it did not", async () => {
    const w = world();
    w.add("t1", true);
    w.add("t2", false);
    const a = w.mb.send(msg("t1", "go"));
    expect(await w.mb.settle(a.id, 1000)).toMatchObject({ delivery: "delivered" });
    const b = w.mb.send(msg("t2", "wait"));
    const r = await w.mb.settle(b.id, 1000);
    expect(r).toEqual({ delivery: "queued", reason: "turn", since: w.now(), kind: "instruction" });
    expect(Mailbox.note(r, w.now())).not.toContain("下一次调用工具时就会读到");
    expect(Mailbox.note(r, w.now())).toContain("它这一轮还在干活");
    expect(Mailbox.note({ delivery: "queued", reason: "unsure", since: w.now() - 3 * 60_000 }, w.now())).toContain("3 分钟");
  });

  it("tells the sender once when its message has been stuck for 2 minutes (not for typing or a draft), and withdraws the receipt once it goes in", async () => {
    const w = world();
    w.add("t1", false);
    w.add("coord", false);
    w.busyReason.set("t1", "unsure");
    const { id } = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "do it" });
    await flushPromises();
    w.tick(STUCK_RECEIPT_MS - 1000);
    await w.mb.tick();
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toEqual([]);
    w.tick(2000);
    await w.mb.tick();
    const receipts = w.repo.queued().filter((m) => m.toSession === "coord");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ kind: "reply", fromSession: null });
    expect(receipts[0].body).toContain(id);
    expect(receipts[0].body).toContain("屏幕上看已经停了");
    // 只发一次：stuck_receipt_at 在库里，换一个 Mailbox（重启）也不重发。
    await w.mb.tick();
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toHaveLength(1);
    expect(w.repo.get(id)!.stuckReceiptAt).not.toBeNull();
    // 送进去了：还排着的回执过时了，撤回。
    w.setWaiting("t1", true);
    w.busyReason.delete("t1");
    await w.mb.tick();
    expect(w.repo.get(id)!.status).toBe("delivered");
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toEqual([]);
  });

  it("withdraws the stuck receipt when the message goes in after the target was refreshed (its head changed while the receipt waited)", async () => {
    const w = world();
    w.add("t1", false);
    w.add("coord", false);
    w.busyReason.set("t1", "unsure");
    const { id } = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "do it" });
    await flushPromises();
    w.tick(STUCK_RECEIPT_MS + 1000);
    await w.mb.tick();
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toHaveLength(1);
    // 目标换新：head 变成 t1b（终端还是同一个）。
    w.sessions.set("t1b", { id: "t1b", waitingForInput: true });
    w.sessions.get("t1")!.replacedBy = "t1b";
    w.busyReason.delete("t1");
    await w.mb.tick();
    expect(w.repo.get(id)!.status).toBe("delivered");
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toEqual([]);
  });

  it("when the reason changes, the queued receipt with the old reason is withdrawn and a receipt with the new reason replaces it", async () => {
    const w = world();
    w.add("t1", false);
    w.add("coord", false);
    w.busyReason.set("t1", "unsure");
    const { id } = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "do it" });
    await flushPromises();
    w.tick(STUCK_RECEIPT_MS + 1000);
    await w.mb.tick();
    const [old] = w.repo.queued().filter((m) => m.toSession === "coord");
    expect(old.body).toContain("屏幕上看已经停了");
    // 终端关了：原因从 unsure 变成 closed。新原因从现在算（blockedSince），2 分钟后才发新的回执。
    w.terms.delete("t1");
    await w.mb.tick();
    expect(w.repo.get(id)!.blockedReason).toBe("closed");
    expect(w.repo.get(old.id)).toBeNull();
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toEqual([]);
    w.tick(STUCK_RECEIPT_MS + 1000);
    await w.mb.tick();
    const receipts = w.repo.queued().filter((m) => m.toSession === "coord");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].body).not.toContain("屏幕上看已经停了");
    expect(receipts[0].body).toContain(M().mailboxBlocked.closed);
    // 原因换成用户在打字：旧回执撤回，不再发新的（打字不发回执）。
    w.terms.set("t1", "t1");
    w.busyReason.delete("t1");
    w.setWaiting("t1", true);
    w.typing.add("t1");
    await w.mb.tick();
    expect(w.repo.get(id)!.blockedReason).toBe("typing");
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toEqual([]);
  });

  it("a later stuck message from the same sender is merged into the receipt still queued, not swapped for it (review suggestion 2)", async () => {
    const w = world();
    // 一直挡着的原因（「在确认」挡久了会硬送，BTL-279）：等用户回答，发件的不是它的总控。
    w.add("t1", true);
    w.needsYou.add("t1");
    w.add("coord", false);
    const a = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "first" });
    await flushPromises();
    w.tick(STUCK_RECEIPT_MS + 1000);
    await w.mb.tick();
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toHaveLength(1);
    const b = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "second" });
    await flushPromises();
    w.tick(STUCK_RECEIPT_MS + 1000);
    await w.mb.tick();
    const receipts = w.repo.queued().filter((m) => m.toSession === "coord");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].body).toContain(a.id);
    expect(receipts[0].body).toContain(b.id);
    expect((receipts[0].meta as { ids: string[] }).ids.sort()).toEqual([a.id, b.id].sort());
    // 一条送进去了，回执里只剩另一条还卡着的不会被当成全部送到。
    expect(w.repo.get(a.id)!.stuckReceiptAt).not.toBeNull();
    expect(w.repo.get(b.id)!.stuckReceiptAt).not.toBeNull();
  });

  it("times the stuck receipt from when the current reason started, not from when it was queued (review suggestion 3)", async () => {
    const w = world();
    w.add("t1", false);
    w.add("coord", false);
    const { id } = w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "x" });
    await flushPromises();
    w.tick(STUCK_TURN_RECEIPT_MS - 60_000);
    await w.mb.tick();
    expect(w.repo.get(id)!.blockedReason).toBe("turn");
    // 这一轮跑完了，屏幕上看停了、正在确认：从现在开始算 2 分钟，不因为排了 9 分钟马上发。
    w.busyReason.set("t1", "unsure");
    await w.mb.tick();
    expect(w.repo.get(id)!.blockedReason).toBe("unsure");
    w.tick(STUCK_RECEIPT_MS - 1000);
    await w.mb.tick();
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toEqual([]);
    w.tick(2000);
    await w.mb.tick();
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toHaveLength(1);
  });

  it("no stuck receipt while the user is typing or has a draft, nor for Shipherd's own notices", async () => {
    const w = world();
    w.add("t1", true);
    w.add("coord", false);
    w.typing.add("t1");
    w.mb.send({ kind: "instruction", from: "coord", to: "t1", featureId: 1, body: "do it" });
    w.mb.send({ kind: "ci", from: null, to: "t1", featureId: 1, body: "CI failed" });
    await flushPromises();
    w.tick(STUCK_RECEIPT_MS + 1000);
    await w.mb.tick();
    expect(w.repo.queued()[0].blockedReason).toBe("typing");
    w.typing.delete("t1");
    w.drafts.add("t1");
    w.tick(STUCK_RECEIPT_MS + 1000);
    await w.mb.tick();
    expect(w.repo.queued()[0].blockedReason).toBe("draft");
    expect(w.repo.queued().filter((m) => m.toSession === "coord")).toEqual([]);
  });

  it("deliver now skips 'unsure', 'needs you' and typing, puts that message first, but still stops for a draft", async () => {
    const w = world();
    w.add("t1", false);
    w.needsYou.add("t1");
    w.typing.add("t1");
    w.mb.send(msg("t1", "first"));
    const { id } = w.mb.send(msg("t1", "the one"));
    await flushPromises();
    expect(w.delivered).toEqual([]);
    // 屏幕上看得出还在干活：马上说 turn，不去等输入框（等也贴不进去，hook 下一次工具调用时送）。
    expect(await w.mb.deliverNow(id)).toEqual({ delivered: false, reason: "turn" });
    expect(w.deliver).not.toHaveBeenCalled();
    w.busyReason.set("t1", "unsure");
    w.drafts.add("t1");
    expect(await w.mb.deliverNow(id)).toEqual({ delivered: false, reason: "draft" });
    expect(w.delivered).toEqual([]);
    w.drafts.delete("t1");
    expect(await w.mb.deliverNow(id)).toEqual({ delivered: true, reason: null });
    expect(w.delivered).toHaveLength(1);
    const text = w.delivered[0].text;
    expect(text.indexOf("the one")).toBeLessThan(text.indexOf("first"));
    // 它在等你回答：从别人那里来的指示不注明「总控在回答」。
    expect(text).not.toContain("总控代答");
    expect(w.repo.queued()).toEqual([]);
    expect(await w.mb.deliverNow("nope")).toEqual({ delivered: false, reason: "gone" });
  });
});
