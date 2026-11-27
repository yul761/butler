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
import { AGE_NOTE_MS, type AwaitingUser, Mailbox, MESSAGE_KEEP_MS, PRUNE_EVERY_MS, REPLY_WAIT_MS, STUCK_RECEIPT_MS, STUCK_TURN_RECEIPT_MS, TAKEN_STALE_MS } from "./mailbox";

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
  /** head -> 挡住它的 busy 细分（不在里面的按 turn）。 */
  const busyReason = new Map<string, "turn" | "unsure">();
  const typing = new Set<string>();
  const drafts = new Set<string>();
  const logs: string[] = [];
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
  const deliver = vi.fn(async (term: string, text: string, recheck: () => boolean): Promise<DeliverResult> => {
    if (!recheck()) return "blocked";
    delivered.push({ term, text });
    return deliverResult;
  });
  const mb = new Mailbox({
    repo, root, head, termOf, openTerms: () => [...terms.keys()],
    check: (id, o): DeliveryCheck => {
      const t = termOf(id);
      if (t === null) return { ok: false, block: "closed" };
      const h = head(id)!;
      // 和真的 guard 一样：force 只跳过「看着停了、还没安静够久」（unsure），屏幕上看得出在干活（turn）照样挡。
      const busy = busyReason.get(h.id) ?? "turn";
      if ((!h.waitingForInput || blocked.has(h.id)) && !(o.force && busy === "unsure")) return { ok: false, block: "busy", busy };
      if (!o.force && !o.answer && needsYou.has(h.id)) return { ok: false, block: "needs_you" };
      if (!o.force && typing.has(h.id)) return { ok: false, block: "typing" };
      if (drafts.has(h.id)) return { ok: false, block: "draft" };
      return { ok: true, termId: t, headId: h.id };
    },
    fromController: (m, h) => controllerOf.get(h) === m.fromSession,
    recheckAfter: () => () => true,
    deliver,
    canInterrupt: () => true,
    interrupt: (t) => interrupts.push(t),
    interruptRecheck: () => () => true,
    lastReply: (id) => replies.get(head(id)?.id ?? id) ?? null,
    nameOf: (id) => (id === null ? "Shipherd" : `S(${id})`),
    typing: (h, phase) => typed.push(`${h}:${phase}`),
    coordinatorAnswered: (h, o) => coordinatorAnswered.push({ head: h, ...o }),
    awaitingUser: (h) => (!needsYou.has(h) ? null : awaiting.has(h) ? awaiting.get(h)! : { asks: [], text: { reason: "asked in text", at: 0 } }),
    wake: (h) => woken.push(h),
    delivered: (m) => deliveredMsgs.push({ id: m.id, via: m.via }),
    held: (h) => held.has(h),
    featureOf: (h) => (h === "t9" ? 9 : null),
    notify: () => {},
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
    controllerOf, busyReason, typing, drafts, logs, coordinatorAnswered, awaiting,
    setWaiting: (id: string, w: boolean) => (sessions.get(id)!.waitingForInput = w),
    tick: (ms: number) => (now += ms),
    now: () => now,
    failDeliver: (r: DeliverResult) => (deliverResult = r),
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
    expect(w.coordinatorAnswered).toEqual([]);
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

  it("settle says delivered when it went in, and queued with the reason when it did not", async () => {
    const w = world();
    w.add("t1", true);
    w.add("t2", false);
    const a = w.mb.send(msg("t1", "go"));
    expect(await w.mb.settle(a.id, 1000)).toMatchObject({ delivery: "delivered" });
    const b = w.mb.send(msg("t2", "wait"));
    const r = await w.mb.settle(b.id, 1000);
    expect(r).toEqual({ delivery: "queued", reason: "turn", since: w.now() });
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
    w.add("t1", false);
    w.add("coord", false);
    w.busyReason.set("t1", "unsure");
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
