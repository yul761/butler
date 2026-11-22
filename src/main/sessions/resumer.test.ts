import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types";
import type { SessionMessage } from "../db/session-messages-repo";
import { MAX_RESUME_ATTEMPTS, MEMORY_RETRY_MS, RESUME_RETRY_MS, Resumer, restartOrder, resumable, type ResumerDeps } from "./resumer";

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1", ticketKey: "ABC-1", cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: false,
  replacedBy: null, dismissed: false, createdAt: 1, repoId: 1, coordinator: false, spawnedBy: "coord", featureId: null, fixesSession: null,
  model: null, butler: false, lessonRunId: null, ...over,
});

const ctx = { ticketArchived: () => false, epicArchived: () => false };

describe("resumable", () => {
  it("takes a ticket session a coordinator started", () => {
    expect(resumable(session(), ctx)).toBe(true);
  });
  it("takes an epic coordinator and a fix session", () => {
    expect(resumable(session({ ticketKey: null, featureId: 3, coordinator: true, spawnedBy: null }), ctx)).toBe(true);
    expect(resumable(session({ ticketKey: null, featureId: 3, fixesSession: "x", spawnedBy: null }), ctx)).toBe(true);
  });
  it("leaves out sessions the user opened, the Butler coordinator, lesson sessions, hidden and outside ones", () => {
    expect(resumable(session({ spawnedBy: null }), ctx)).toBe(false);
    expect(resumable(session({ ticketKey: null, butler: true, spawnedBy: null }), ctx)).toBe(false);
    expect(resumable(session({ ticketKey: null, lessonRunId: 4 }), ctx)).toBe(false);
    expect(resumable(session({ dismissed: true }), ctx)).toBe(false);
    expect(resumable(session({ origin: "discovered" as Session["origin"] }), ctx)).toBe(false);
    expect(resumable(session({ replacedBy: "s2" }), ctx)).toBe(false);
  });
  it("leaves out archived tickets and epics", () => {
    expect(resumable(session(), { ...ctx, ticketArchived: () => true })).toBe(false);
    expect(resumable(session({ ticketKey: null, featureId: 3, coordinator: true }), { ...ctx, epicArchived: () => true })).toBe(false);
  });
});

describe("restartOrder", () => {
  it("puts unread mail first, then open PRs, then the most recently active", () => {
    const a = session({ id: "a", lastActivityAt: 30 });
    const b = session({ id: "b", lastActivityAt: 10, ticketKey: "ABC-2" });
    const c = session({ id: "c", lastActivityAt: 20, ticketKey: "ABC-3" });
    const d = session({ id: "d", lastActivityAt: 40, ticketKey: "ABC-4" });
    const order = restartOrder([a, b, c, d], (id) => id === "c", (h) => h.ticketKey === "ABC-2");
    expect(order.map((x) => x.id)).toEqual(["c", "b", "d", "a"]);
  });
});

type Opened = { ok: true; termId: string; alreadyOpen: boolean } | { ok: false; reason: string };

function setup(over: Partial<ResumerDeps> = {}) {
  let now = 1_000_000;
  const heads = new Map<string, Session>([["s1", session()]]);
  const running = new Set<string>();
  const started = new Set<string>();
  const receipts: { to: string; body: string }[] = [];
  const release = vi.fn();
  const d: ResumerDeps = {
    head: (id) => heads.get(id) ?? null,
    running: (id) => running.has(id),
    resumable: (h) => resumable(h, ctx),
    transcript: () => "present",
    admit: vi.fn(async () => ({ ok: true as const, release })),
    open: vi.fn(async (h: Session): Promise<Opened> => {
      running.add(h.id);
      started.add(h.id);
      return { ok: true, termId: h.id, alreadyOpen: false };
    }),
    started: (t) => started.has(t),
    isOpen: (t) => running.has(t),
    setWakeError: vi.fn((id: string, error: string | null, at: number | null) => {
      const h = heads.get(id);
      if (h) heads.set(id, { ...h, wakeError: error, wakeErrorAt: at });
    }),
    waitingSenders: () => [{ id: "m1", from: "coord", featureId: 7 }],
    receipt: (to, _f, body) => receipts.push({ to, body }),
    nameOf: (id) => id ?? "Butler",
    notify: () => undefined,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: () => undefined,
    startTimeoutMs: 1000,
    ...over,
  };
  return { r: new Resumer(d), d, heads, running, started, receipts, release, tick: (ms: number) => (now += ms) };
}

const msg = (over: Partial<SessionMessage> = {}): SessionMessage => ({
  id: "m1", kind: "instruction", fromSession: "coord", toSession: "s1", featureId: 7, body: "hi", queuedAt: 1, interrupt: false, ref: null, meta: null,
  expectsReply: true, status: "delivered", via: "input", deliveredAt: 2, baseReplyId: null, replyText: null, repliedAt: null, ...over,
} as SessionMessage);

describe("Resumer", () => {
  it("resumes a closed managed session in the background after admission", async () => {
    const { r, d } = setup();
    await expect(r.request("s1", "mail")).resolves.toEqual({ state: "resuming" });
    expect(d.admit).toHaveBeenCalledTimes(1);
    expect(d.open).toHaveBeenCalledTimes(1);
    await r.idle();
    expect(r.status("s1")).toBe("running");
  });

  it("opens only once for several messages arriving together", async () => {
    const { r, d } = setup();
    const all = await Promise.all([r.request("s1", "mail"), r.request("s1", "mail"), r.request("s1", "mail")]);
    expect(all.every((x) => x.state === "resuming")).toBe(true);
    expect(d.open).toHaveBeenCalledTimes(1);
    await r.idle();
    await expect(r.request("s1", "mail")).resolves.toEqual({ state: "running" });
    expect(d.open).toHaveBeenCalledTimes(1);
  });

  it("keeps the message queued when memory is short and does not ask again within a minute", async () => {
    const admit = vi.fn(async () => ({ ok: false as const, error: "only 1 GB free" }));
    const { r, d, tick } = setup({ admit });
    await expect(r.request("s1", "mail")).resolves.toEqual({ state: "waiting_memory", error: "only 1 GB free" });
    await expect(r.request("s1", "mail")).resolves.toEqual({ state: "waiting_memory", error: "only 1 GB free" });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(r.status("s1")).toBe("waiting_memory");
    expect(d.open).not.toHaveBeenCalled();
    tick(MEMORY_RETRY_MS);
    await r.request("s1", "mail");
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it("does not resume a session the user ended", async () => {
    const { r, d, heads } = setup();
    heads.set("s1", session({ userEndedAt: 5 }));
    await expect(r.request("s1", "mail")).resolves.toEqual({ state: "ended_by_user" });
    expect(r.status("s1")).toBe("ended_by_user");
    expect(d.admit).not.toHaveBeenCalled();
  });

  it("does not resume sessions it does not manage", async () => {
    const { r, d, heads } = setup();
    heads.set("s1", session({ spawnedBy: null }));
    await expect(r.request("s1", "mail")).resolves.toEqual({ state: "not_managed" });
    expect(d.admit).not.toHaveBeenCalled();
  });

  it("gives up for good when the transcript is gone, and tells the sender", async () => {
    const { r, d, receipts, heads } = setup({ transcript: () => "absent" });
    heads.set("s1", session({ firstPrompt: "build it" }));
    const got = await r.request("s1", "mail");
    expect(got.state).toBe("resume_failed");
    expect(d.open).not.toHaveBeenCalled();
    expect(d.setWakeError).toHaveBeenCalled();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].to).toBe("coord");
    await r.request("s1", "mail");
    expect(receipts).toHaveLength(1);
  });

  it("opens a session that never said anything even without a transcript (its first message becomes the first input)", async () => {
    const { r, d } = setup({ transcript: () => "absent" });
    await expect(r.request("s1", "mail")).resolves.toEqual({ state: "resuming" });
    expect(d.open).toHaveBeenCalledTimes(1);
  });

  it("keeps counting tries when claude exits right after its own open (sessionService.opened fires inside open)", async () => {
    const ref: { r?: Resumer } = {};
    const open = vi.fn(async (h: Session): Promise<Opened> => {
      ref.r!.opened(h.id);
      return { ok: true, termId: h.id, alreadyOpen: false };
    });
    const s = setup({ open, isOpen: () => false, started: () => false });
    const r = (ref.r = s.r);
    for (let i = 0; i < MAX_RESUME_ATTEMPTS + 3; i++) {
      await r.request("s1", "mail");
      await r.idle();
      s.tick(RESUME_RETRY_MS);
    }
    expect(open).toHaveBeenCalledTimes(MAX_RESUME_ATTEMPTS);
    expect(s.receipts).toHaveLength(MAX_RESUME_ATTEMPTS);
    expect(r.status("s1")).toBe("resume_failed");
  });

  it("does not report a failure when it is still open after the timeout, nor when the user ended it while starting", async () => {
    const a = setup({ started: () => false, isOpen: () => true });
    await a.r.request("s1", "mail");
    await a.r.idle();
    expect(a.receipts).toEqual([]);
    expect(a.d.setWakeError).not.toHaveBeenCalled();
    const b = setup({ started: () => false, isOpen: () => false });
    b.heads.set("s1", session());
    b.d.open = vi.fn(async (h: Session): Promise<Opened> => {
      b.heads.set(h.id, session({ userEndedAt: 9 }));
      return { ok: true, termId: h.id, alreadyOpen: false };
    });
    await b.r.request("s1", "mail");
    await b.r.idle();
    expect(b.receipts).toEqual([]);
    expect(b.r.status("s1")).toBe("ended_by_user");
  });

  it("does nothing once Butler is quitting", async () => {
    const { r, d, receipts } = setup({ started: () => false, isOpen: () => false });
    r.stop();
    await expect(r.request("s1", "mail")).resolves.toEqual({ state: "not_managed" });
    expect(d.open).not.toHaveBeenCalled();
    expect(receipts).toEqual([]);
  });

  it("returns the admission slot and backs off when claude does not start, at most a few tries", async () => {
    const open = vi.fn(async (): Promise<Opened> => ({ ok: false, reason: "claude_missing" }));
    const { r, release, receipts, tick, heads } = setup({ open });
    for (let i = 0; i < MAX_RESUME_ATTEMPTS + 2; i++) {
      await r.request("s1", "mail");
      await r.idle();
      tick(RESUME_RETRY_MS);
    }
    expect(open).toHaveBeenCalledTimes(MAX_RESUME_ATTEMPTS);
    expect(release).toHaveBeenCalledTimes(MAX_RESUME_ATTEMPTS);
    expect(receipts).toHaveLength(MAX_RESUME_ATTEMPTS);
    expect(heads.get("s1")?.wakeError).toContain("claude_missing");
    expect(r.status("s1")).toBe("resume_failed");
  });

  it("waits out the retry delay after a failure", async () => {
    const open = vi.fn(async (): Promise<Opened> => ({ ok: false, reason: "error" }));
    const { r } = setup({ open });
    await r.request("s1", "mail");
    await expect(r.request("s1", "mail")).resolves.toMatchObject({ state: "resume_failed" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("counts claude exiting before SessionStart as a failure", async () => {
    const { r, d, running, receipts } = setup();
    d.open = vi.fn(async (h: Session): Promise<Opened> => ({ ok: true, termId: h.id, alreadyOpen: false }));
    running.delete("s1");
    await expect(r.request("s1", "mail")).resolves.toEqual({ state: "resuming" });
    await r.idle();
    expect(r.status("s1")).toBe("resume_failed");
    expect(receipts).toHaveLength(1);
  });

  it("forgets failures once the session is opened some other way", async () => {
    const open = vi.fn(async (): Promise<Opened> => ({ ok: false, reason: "error" }));
    const { r } = setup({ open });
    await r.request("s1", "mail");
    r.opened("s1");
    await r.request("s1", "mail");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("sends one receipt per sender when the resumed session gets its messages", async () => {
    const { r, receipts } = setup();
    await r.request("s1", "mail");
    await r.idle();
    r.delivered(msg({ id: "m1" }));
    r.delivered(msg({ id: "m2" }));
    r.delivered(msg({ id: "m3", fromSession: null, kind: "ci" }));
    await Promise.resolve();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].body).toContain("m1");
    expect(receipts[0].body).toContain("m2");
    // 之后再送到的不再发回执。
    r.delivered(msg({ id: "m4" }));
    await Promise.resolve();
    expect(receipts).toHaveLength(1);
  });

  it("sends no delivery receipt when the first delivery after the resume is not from a coordinator, nor later", async () => {
    const { r, receipts } = setup();
    await r.request("s1", "mail");
    await r.idle();
    r.delivered(msg({ id: "c1", fromSession: null, kind: "ci" }));
    await Promise.resolve();
    r.delivered(msg({ id: "m9" }));
    await Promise.resolve();
    expect(receipts).toEqual([]);
  });

  it("finds the resumed session when claude came back under a new id", async () => {
    const { r, receipts, heads } = setup();
    await r.request("s1", "mail");
    await r.idle();
    heads.set("s1", session({ replacedBy: "s2" }));
    heads.set("s2", session({ id: "s2" }));
    const head = (id: string) => (id === "s1" ? heads.get("s2")! : (heads.get(id) ?? null));
    (r as unknown as { d: ResumerDeps }).d.head = head;
    r.delivered(msg({ id: "m1", toSession: "s2" }));
    await Promise.resolve();
    expect(receipts).toHaveLength(1);
  });

  it("does not send delivery receipts for sessions it did not resume", async () => {
    const { r, receipts } = setup();
    r.delivered(msg());
    await Promise.resolve();
    expect(receipts).toEqual([]);
  });

  it("releases the slot when the terminal was already open", async () => {
    const { r, d, release } = setup();
    d.open = vi.fn(async (h: Session): Promise<Opened> => ({ ok: true, termId: h.id, alreadyOpen: true }));
    await expect(r.request("s1", "mail")).resolves.toEqual({ state: "running" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("resumes after a restart in order and stops at the first memory refusal", async () => {
    const heads = ["a", "b", "c"].map((id) => session({ id }));
    let n = 0;
    const admit = vi.fn(async () => (++n <= 1 ? { ok: true as const, release: () => undefined } : { ok: false as const, error: "no memory" }));
    const { r, d } = setup({ admit, head: (id) => heads.find((h) => h.id === id) ?? null });
    const done = await r.resumeAll(heads);
    expect(done).toEqual({ resumed: ["a"], waitingMemory: ["b", "c"] });
    expect(admit).toHaveBeenCalledTimes(2);
    expect(d.open).toHaveBeenCalledTimes(1);
  });
});
