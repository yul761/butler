import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runMailbox } from "../../../hook/mailbox";
import type { Session } from "../../shared/types";
import { SessionMessagesRepo } from "../db/session-messages-repo";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { memDb } from "../test-utils";
import { AGE_NOTE_MS, Mailbox, MESSAGE_KEEP_MS, REPLY_WAIT_MS, TAKEN_STALE_MS } from "./mailbox";

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
  const delivered: { term: string; text: string }[] = [];
  let deliverResult: DeliverResult = "sent";
  const interrupts: string[] = [];
  const typed: string[] = [];
  const woken: string[] = [];
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
    check: (id): DeliveryCheck => {
      const t = termOf(id);
      if (t === null) return { ok: false, block: "closed" };
      const h = head(id)!;
      if (!h.waitingForInput || blocked.has(h.id)) return { ok: false, block: "busy" };
      return { ok: true, termId: t, headId: h.id };
    },
    recheckAfter: () => () => true,
    deliver,
    canInterrupt: () => true,
    interrupt: (t) => interrupts.push(t),
    interruptRecheck: () => () => true,
    lastReply: (id) => replies.get(head(id)?.id ?? id) ?? null,
    nameOf: (id) => (id === null ? "Butler" : `S(${id})`),
    typing: (h, phase) => typed.push(`${h}:${phase}`),
    wake: (h) => woken.push(h),
    notify: () => {},
    now: () => now,
    log: () => {},
  });
  const add = (id: string, waiting: boolean, open = true) => {
    sessions.set(id, { id, waitingForInput: waiting });
    if (open) terms.set(id, id);
  };
  const dirFiles = (term: string) => (existsSync(join(root, term)) ? readdirSync(join(root, term)).sort() : null);
  return {
    root, repo, mb, sessions, terms, replies, blocked, delivered, deliver, interrupts, typed, woken, add, dirFiles,
    setWaiting: (id: string, w: boolean) => (sessions.get(id)!.waitingForInput = w),
    tick: (ms: number) => (now += ms),
    now: () => now,
    failDeliver: (r: DeliverResult) => (deliverResult = r),
    hook: (term: string, tool = "Read") => runMailbox(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: tool }), { BUTLER_SESSION: term }, root),
  };
}

const msg = (to: string, body: string, extra: Record<string, unknown> = {}) => ({ kind: "instruction" as const, from: "boss", to, featureId: 1, body, ...extra });

describe("Mailbox", () => {
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
    w.mb.send({ ...msg("t1", "wake up"), kind: "butler", hold: true });
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
    w.mb.send({ ...msg("t1", "wake up"), kind: "butler" });
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

  it("lists messages for a feature or for Butler's sessions with readable names", () => {
    const w = world();
    w.add("t1", false);
    w.mb.send(msg("t1", "x"));
    w.mb.send({ ...msg("t1", "y"), from: "butler", featureId: null, kind: "butler" });
    expect(w.mb.views({ featureId: 1 }, []).map((v) => [v.from, v.to, v.status, v.text])).toEqual([["S(boss)", "S(t1)", "queued", "x"]]);
    expect(w.mb.views({ butler: true }, ["butler"]).map((v) => v.text)).toEqual(["y"]);
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
});
