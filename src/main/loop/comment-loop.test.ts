import { describe, expect, it, vi } from "vitest";
import { fakeMailbox } from "../mailbox/fake-mailbox";
import { MAILBOX_BODY_LIMIT } from "../mailbox/mailbox";
import { memDb } from "../test-utils";
import { CommentItemsRepo } from "../db/comment-items-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import type { PrStatus } from "../tickets/gh";
import type { ReviewThread } from "../tickets/gh-loop";
import { LOOP_POLICY_DEFAULTS, type LoopPolicy } from "../../shared/loop-policy";
import { COMMENT_UNDELIVERED_MS, CommentLoop, patchRanges, replyText, touches, type CommentLoopDeps } from "./comment-loop";
import type { CommentVerdicts } from "./comment-model";

const thread = (o: Partial<ReviewThread> & { body?: string; author?: string; type?: string; dbId?: number } = {}): ReviewThread => ({
  id: o.id ?? "T1", isResolved: o.isResolved ?? false, isOutdated: o.isOutdated ?? false, path: o.path ?? "src/a.ts", line: o.line === undefined ? 12 : o.line, originalLine: 12,
  comments: o.comments ?? [{ databaseId: o.dbId ?? 101, author: o.author ?? "copilot-pull-request-reviewer", authorType: o.type ?? "Bot", body: o.body ?? "This variable shadows the outer one.", createdAt: "2026-11-18T00:00:00Z", url: "https://example.test/c/101", path: "src/a.ts", line: 12, originalLine: 12, commit: "aaa" }],
});

function setup(over: Partial<LoopPolicy> = {}, o: { verdicts?: (ids: string[]) => CommentVerdicts | null; allowed?: Partial<Record<string, boolean>>; guardOk?: boolean } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", createdAt: 1 });
  const prs = new TicketPrsRepo(db);
  const { pr: row0 } = prs.link({ ticketKey: "T-1", url: "https://github.com/o/r/pull/34", slug: "o/r", repoId, number: 34, headBranch: "b", state: "open", source: "branch", linkedAt: 1 });
  prs.update(row0.id, { headSha: "aaa1111", checkedAt: 1 });
  const items = new CommentItemsRepo(db);
  let t = 1000;
  let threads: ReviewThread[] = [thread()];
  let patch = "@@ -10,5 +10,6 @@\n-x\n+y";
  const calls = {
    threads: 0, compares: 0, replies: [] as string[], prComments: [] as string[], resolves: [] as string[], model: [] as string[][], audits: [] as string[],
    events: [] as { kind: string; dedupeKey?: string; data?: Record<string, unknown> }[],
  };
  const deliver = vi.fn<(term: string, text: string) => Promise<"sent">>(async () => "sent");
  const guard = { ok: o.guardOk ?? true };
  const mailbox = fakeMailbox({ canDeliver: () => guard.ok, deliver: (_to, body) => void deliver("t1", body), now: () => t });
  const policy = { ...LOOP_POLICY_DEFAULTS, "comments.enabled": true, ...over };
  const policyAsks: [string | null, string | null | undefined][] = [];
  const d: CommentLoopDeps = {
    items, prs, policy: (slug, ticketKey) => (policyAsks.push([slug, ticketKey]), policy), cwdOf: () => "/r",
    gh: {
      reviewThreads: async () => (calls.threads++, threads),
      compareFiles: async () => (calls.compares++, [{ filename: "src/a.ts", patch }]),
      replyToReviewComment: async (_c, _n, id, body) => (calls.replies.push(`${id}:${body}`), { ok: true, url: null }),
      commentOnPr: async (_c, _n, body) => (calls.prComments.push(body), { ok: true, url: null }),
      resolveReviewThread: async (_c, id) => (calls.resolves.push(id), { ok: true, url: null }),
    },
    model: async (_cwd, list) => {
      const ids = list.map((i) => i.id);
      calls.model.push(ids);
      return o.verdicts ? o.verdicts(ids) : new Map(ids.map((id) => [id, { category: "fix" as const, reason: "a real bug" }]));
    },
    external: {
      attempt: (async (kind: string, _detail: unknown, run: () => Promise<unknown>) => {
        if (o.allowed?.[kind] === false) return calls.audits.push(`${kind}:skipped`), { ran: false, auditId: 1 };
        const value = await run();
        calls.audits.push(`${kind}:done`);
        return { ran: true, value, auditId: 1 };
      }) as CommentLoopDeps["external"]["attempt"],
    },
    recipient: () => ({ ok: true, sessionId: "h1", via: "owner" }),
    mailbox,
    recordEvent: (kind, refs) => (calls.events.push({ kind, dedupeKey: refs?.dedupeKey, data: refs?.data }), true),
    changed: () => undefined, now: () => t, log: () => undefined, headOf: (id) => (id === "old-h1" ? "h1" : id),
  };
  const loop = new CommentLoop(d);
  const status = (o2: Partial<PrStatus> = {}): PrStatus => ({
    number: 34, url: "https://github.com/o/r/pull/34", state: "OPEN", isDraft: false, review: null, headSha: "aaa1111", headBranch: "b", checks: [], ci: "passing",
    author: "me", reviews: [], comments: [], firstCommitAt: null, createdAt: null, mergedAt: null, closedAt: null, baseBranch: "main", title: null, labels: [],
    reviewRequests: [], mergeable: null, mergeState: null, ...o2,
  });
  const observe = async (o2: Partial<PrStatus> = {}) => {
    const s = status(o2);
    if (s.headSha !== prs.get(row0.id)!.headSha) prs.update(row0.id, { headSha: s.headSha });
    await loop.observe([prs.get(row0.id)!], s, { cwd: "/r", slug: "o/r" });
  };
  return {
    loop, items, prs, tickets, row: row0, calls, deliver, guard, observe, status, mailbox, policyAsks,
    advance: (ms: number) => void (t += ms),
    setThreads: (x: ReviewThread[]) => void (threads = x),
    setPatch: (p: string) => void (patch = p),
  };
}

describe("patchRanges / touches", () => {
  it("reads hunk ranges and checks the line with some slack", () => {
    expect(patchRanges("@@ -10,5 +12,0 @@\n@@ -40 +40 @@")).toEqual({ old: [[10, 14], [40, 40]], new: [[12, 12], [40, 40]] });
    expect(touches("@@ -10,5 +10,6 @@", 16, null)).toBe(true);
    expect(touches("@@ -10,5 +10,6 @@", 18, null)).toBe(false);
    expect(touches("@@ -100,2 +100,2 @@", 5, 99)).toBe(true);
  });

  it("writes the fixed, restrained reply in the chosen language", () => {
    expect(replyText("en", "abc1234", null)).toBe("Addressed in abc1234.\n\n<sub>(automated reply from Shipherd)</sub>");
    expect(replyText("zh", "abc1234", "Please add a test\nmore")).toBe("> Please add a test\n\n已在 abc1234 中修改。\n\n<sub>（Shipherd 自动回复）</sub>");
  });
});

describe("CommentLoop", () => {
  it("does nothing while the policy is off", async () => {
    const s = setup({ "comments.enabled": false });
    await s.observe();
    expect(s.calls.threads).toBe(0);
  });

  it("delivers a Copilot comment, checks the place after the push, then replies and resolves", async () => {
    const s = setup();
    await s.observe();
    expect(s.calls.model).toEqual([[String(s.items.byPr(s.row.id)[0].id)]]);
    expect(s.deliver).toHaveBeenCalledTimes(1);
    const text = (s.deliver.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toContain("src/a.ts:12");
    expect(text).toContain("This variable shadows the outer one.");
    expect(text).toContain("PR #34");
    expect(s.items.byPr(s.row.id)[0]).toMatchObject({ state: "delivered", deliveredSha: "aaa1111", deliveredSession: "h1", category: "fix", source: "model" });
    // 同一个样子再读到：不再拉 thread。
    await s.observe();
    expect(s.calls.threads).toBe(1);
    // push 了：thread 的那几行被改了。
    await s.observe({ headSha: "bbb2222" });
    const it = s.items.byPr(s.row.id)[0];
    expect(it).toMatchObject({ state: "addressed", verified: "patch", addressedSha: "bbb2222" });
    expect(s.calls.replies).toEqual(["101:Addressed in bbb2222.\n\n<sub>(automated reply from Shipherd)</sub>"]);
    expect(s.calls.resolves).toEqual(["T1"]);
    expect(s.calls.events).toEqual([{ kind: "comment_auto_handled", dedupeKey: `comment:${s.row.id}:101`, data: { who: "copilot", category: "fix", source: "model", verified: "patch" } }]);
    expect(it.repliedAt).not.toBeNull();
    expect(it.resolvedAt).not.toBeNull();
  });

  it("handles a PR linked to two tickets once: one delivery, one reply, one resolve", async () => {
    const s = setup();
    s.tickets.insert({ key: "T-2", title: null, status: "active", statusManual: null, createdAt: 2, archivedAt: null });
    s.prs.link({ ticketKey: "T-2", url: "https://github.com/o/r/pull/34", slug: "o/r", repoId: s.row.repoId, number: 34, headBranch: "b", state: "open", source: "branch", linkedAt: 2 });
    const rows = () => s.prs.byUrl("https://github.com/o/r/pull/34");
    expect(rows()).toHaveLength(2);
    await s.loop.observe(rows(), s.status(), { cwd: "/r", slug: "o/r" });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.items.byPr(rows()[1].id)).toHaveLength(0);
    for (const r of rows()) s.prs.update(r.id, { headSha: "bbb2222" });
    await s.loop.observe(rows(), s.status({ headSha: "bbb2222" }), { cwd: "/r", slug: "o/r" });
    expect(s.calls.replies).toHaveLength(1);
    expect(s.calls.resolves).toEqual(["T1"]);
    // 两个 ticket 的「评论」标签都看得到这条。
    expect(s.loop.list("T-1")[0].items).toHaveLength(1);
    expect(s.loop.list("T-2")[0].items).toHaveLength(1);
  });

  it("reads the policy for the PR's ticket, so an epic's automation level applies (BTL-247)", async () => {
    const s = setup();
    await s.observe();
    s.policyAsks.length = 0;
    s.loop.list("T-1");
    expect(s.policyAsks).toEqual([["o/r", "T-1"]]);
  });

  it("keeps your choice when the model answers after you dismissed the comment", async () => {
    let release: () => void = () => undefined;
    const s = setup({}, {});
    const slow = new Promise<void>((r) => (release = r));
    const original = s.loop["d"].model;
    s.loop["d"].model = async (cwd, list) => (await slow, original(cwd, list));
    const run = s.observe();
    await new Promise((r) => setImmediate(r));
    const [it] = s.items.byPr(s.row.id);
    expect(it.state).toBe("pending");
    await s.loop.act({ op: "dismiss", id: it.id });
    release();
    await run;
    expect(s.items.get(it.id)!.state).toBe("dismissed");
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("does not deliver twice when two flushes overlap", async () => {
    const s = setup({ "comments.copilot": "review" });
    await s.observe();
    const [it] = s.items.byPr(s.row.id);
    await s.loop.act({ op: "send", id: it.id });
    await Promise.all([s.loop.flush(), s.loop.flush()]);
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });

  it("does not reply twice when reply is clicked twice", async () => {
    const s = setup({ "comments.reply": false });
    await s.observe();
    await s.observe({ headSha: "bbb2222" });
    const [it] = s.items.byPr(s.row.id);
    expect(it.state).toBe("addressed");
    await Promise.all([s.loop.act({ op: "reply", id: it.id }), s.loop.act({ op: "reply", id: it.id })]);
    expect(s.calls.replies).toHaveLength(1);
    expect(await s.loop.act({ op: "reply", id: it.id })).toBeNull();
    expect(s.calls.replies).toHaveLength(1);
  });

  it("appends the stack note to the delivery and reports comments awaiting a check (workstream K)", async () => {
    const s = setup();
    s.loop["d"].stackNote = (row) => `stack note for #${row.number}`;
    expect(s.loop.awaitingCheck(s.row.id)).toBe(false);
    await s.observe();
    const text = (s.deliver.mock.calls[0] as unknown as [string, string])[1];
    expect(text.trimEnd().endsWith("stack note for #34")).toBe(true);
    expect(s.loop.awaitingCheck(s.row.id)).toBe(true);
    await s.observe({ headSha: "bbb2222" });
    expect(s.loop.awaitingCheck(s.row.id)).toBe(false);
    expect(s.loop.awaitingCheck(9999)).toBe(false);
  });

  it("hides the Now notices while comments are off", async () => {
    const s = setup({}, { verdicts: () => null });
    s.setThreads([thread({ author: "alice", type: "User", body: "Hmm." })]);
    await s.observe();
    expect(s.items.byPr(s.row.id)[0].state).toBe("review");
    expect(s.loop.waiting()).toHaveLength(1);
    s.loop["d"].policy = () => ({ ...LOOP_POLICY_DEFAULTS, "comments.enabled": false });
    expect(s.loop.waiting()).toHaveLength(0);
  });

  it("shows people's comments to you first; send puts them into the session", async () => {
    const s = setup();
    s.setThreads([thread({ author: "alice", type: "User", body: "Can we split this function?" })]);
    await s.observe();
    expect(s.deliver).not.toHaveBeenCalled();
    const [it] = s.items.byPr(s.row.id);
    expect(it).toMatchObject({ state: "review", who: "human", category: "fix" });
    expect(s.loop.waiting()).toEqual([{ reason: "review", ticketKey: "T-1", prId: s.row.id, number: 34, count: 1, since: 1000 }]);
    const v = await s.loop.act({ op: "send", id: it.id });
    expect(v?.state).toBe("queued");
    await s.loop.flush();
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.items.get(it.id)!.state).toBe("delivered");
  });

  it("sendAll queues every comment waiting for you and delivers them; sendable says whether there is any (UI redesign layer 1)", async () => {
    const s = setup();
    s.setThreads([
      thread({ id: "T1", dbId: 101, author: "alice", type: "User", body: "Split this." }),
      thread({ id: "T2", dbId: 102, author: "bob", type: "User", body: "Rename that.", path: "src/b.ts" }),
    ]);
    await s.observe();
    expect(s.items.byPr(s.row.id).map((i) => i.state)).toEqual(["review", "review"]);
    expect(s.loop.sendable(s.row.id)).toBe(true);
    expect(await s.loop.sendAll(s.row.id)).toBe(2);
    expect(s.deliver).toHaveBeenCalledTimes(1);
    expect(s.items.byPr(s.row.id).map((i) => i.state)).toEqual(["delivered", "delivered"]);
    expect(s.loop.sendable(s.row.id)).toBe(false);
    expect(await s.loop.sendAll(s.row.id)).toBe(0);
  });

  it("with comments.enabled turned off later, nothing is sendable and sendAll queues nothing (UI redesign layer 1)", async () => {
    const s = setup();
    s.setThreads([thread({ id: "T1", dbId: 101, author: "alice", type: "User", body: "Split this." })]);
    await s.observe();
    expect(s.loop.sendable(s.row.id)).toBe(true);
    s.loop["d"].policy = () => ({ ...LOOP_POLICY_DEFAULTS, "comments.enabled": false });
    expect(s.loop.sendable(s.row.id)).toBe(false);
    expect(await s.loop.sendAll(s.row.id)).toBe(0);
    expect(s.items.byPr(s.row.id).map((i) => i.state)).toEqual(["review"]);
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("deliveredAt is the latest delivery to that session's chain (UI redesign layer 1)", async () => {
    const s = setup();
    await s.observe();
    expect(s.items.byPr(s.row.id)[0]).toMatchObject({ state: "delivered", deliveredSession: "h1", deliveredAt: 1000 });
    expect(s.loop.deliveredAt(s.row.id, "h1")).toBe(1000);
    expect(s.loop.deliveredAt(s.row.id, "h2")).toBeNull();
    // 记下的 session 换新了：按 head 比
    s.items.update(s.items.byPr(s.row.id)[0].id, { deliveredSession: "old-h1" }, 1000);
    expect(s.loop.deliveredAt(s.row.id, "h1")).toBe(1000);
  });

  it("never asks the model for what the rules settle, and files model failures as needing you", async () => {
    const s = setup({}, { verdicts: () => null });
    s.setThreads([
      thread({ id: "T1", dbId: 1, body: "LGTM" }),
      thread({ id: "T2", dbId: 2, body: "```suggestion\nconst x = 1;\n```" }),
      thread({ id: "T3", dbId: 3, body: "Hmm, not sure about this approach." }),
      thread({ id: "T4", dbId: 4, isOutdated: true }),
      thread({ id: "T5", dbId: 5, isResolved: true }),
    ]);
    await s.observe();
    const by = Object.fromEntries(s.items.byPr(s.row.id).map((i) => [i.key, [i.state, i.category, i.reason]]));
    expect(by).toEqual({
      1: ["ignored", "ignore", "ack"], 2: ["delivered", "fix", "suggestion"], 3: ["review", "human", "model_failed"], 4: ["ignored", "ignore", "outdated"],
    });
    expect(s.calls.model).toHaveLength(1);
    expect(s.calls.model[0]).toHaveLength(1);
  });

  it("hands a comment to you after two pushes that did not touch it", async () => {
    const s = setup();
    s.setPatch("@@ -200,1 +200,1 @@");
    await s.observe();
    await s.observe({ headSha: "bbb2222" });
    expect(s.items.byPr(s.row.id)[0]).toMatchObject({ state: "delivered", unchanged: 1 });
    await s.observe({ headSha: "ccc3333" });
    expect(s.items.byPr(s.row.id)[0]).toMatchObject({ state: "review", category: "human", reason: "unchanged_twice" });
    expect(s.calls.replies).toEqual([]);
  });

  it("records skipped replies when the outward switch is off, and still resolves by its own switch", async () => {
    const s = setup({}, { allowed: { comment_reply: false } });
    s.setThreads([thread({ isOutdated: false })]);
    await s.observe();
    s.setThreads([thread({ isOutdated: true })]);
    await s.observe({ headSha: "bbb2222" });
    expect(s.calls.audits).toEqual(["comment_reply:skipped", "comment_resolve:done"]);
    expect(s.calls.replies).toEqual([]);
    expect(s.items.byPr(s.row.id)[0]).toMatchObject({ state: "addressed", verified: "outdated", repliedAt: null });
  });

  it("replies to a PR-level comment with a quote after any new commit, without resolving", async () => {
    const s = setup({ "comments.human": "auto" });
    s.setThreads([]);
    await s.observe({ comments: [{ id: "IC1", author: "bob", body: "Please add a changelog entry.", createdAt: 1, url: "https://example.test/ic1", path: null, line: null, reviewId: null }] });
    expect(s.deliver).toHaveBeenCalledTimes(1);
    await s.observe({ headSha: "bbb2222", comments: [{ id: "IC1", author: "bob", body: "Please add a changelog entry.", createdAt: 1, url: "https://example.test/ic1", path: null, line: null, reviewId: null }] });
    expect(s.items.byPr(s.row.id)[0]).toMatchObject({ state: "addressed", verified: "commit" });
    expect(s.calls.prComments).toEqual(["> Please add a changelog entry.\n\nAddressed in bbb2222.\n\n<sub>(automated reply from Shipherd)</sub>"]);
    expect(s.calls.resolves).toEqual([]);
  });

  it("waits while the session is busy and reports it after 30 minutes", async () => {
    const s = setup({}, { guardOk: false });
    await s.observe();
    expect(s.deliver).not.toHaveBeenCalled();
    expect(s.loop.waiting()).toEqual([]);
    s.advance(COMMENT_UNDELIVERED_MS);
    expect(s.loop.waiting()).toMatchObject([{ reason: "undelivered", count: 1 }]);
    s.guard.ok = true;
    // 信箱自己会在 session 停下时送（BTL-245）；flush 不再排第二条。
    await s.loop.flush();
    expect(s.mailbox.queued.size).toBe(1);
    s.mailbox.deliverQueued();
    expect(s.deliver).toHaveBeenCalledTimes(1);
  });

  it("a busy session gets one queued message per PR: new comments replace it, dismissing the last one withdraws it (BTL-245)", async () => {
    const s = setup({}, { guardOk: false });
    await s.observe();
    expect(s.mailbox.queued.size).toBe(1);
    s.setThreads([thread(), thread({ id: "T2", dbId: 102, body: "Second finding.", line: 40 })]);
    await s.observe({ reviews: [{ id: "R2", author: "copilot-pull-request-reviewer", state: "COMMENTED", body: "", submittedAt: 1 }] as PrStatus["reviews"] });
    expect(s.mailbox.queued.size).toBe(1);
    const [msg] = [...s.mailbox.queued.values()];
    expect(msg.body).toContain("Second finding.");
    expect((msg.meta as { items: number[] }).items).toHaveLength(2);
    for (const it of s.items.byPr(s.row.id)) await s.loop.act({ op: "dismiss", id: it.id });
    await s.loop.flush();
    expect(s.mailbox.queued.size).toBe(0);
  });

  it("sends only as many long comments as fit in one mailbox message; the rest stay queued for the next one (BTL-245)", async () => {
    const s = setup({}, { guardOk: false });
    const long = (n: number) => `Finding ${n}. ${"x".repeat(900)}`;
    s.setThreads(Array.from({ length: 10 }, (_, n) => thread({ id: `T${n}`, dbId: 200 + n, body: long(n), line: 10 + n })));
    await s.observe();
    const [msg] = [...s.mailbox.queued.values()];
    expect(msg.body.length).toBeLessThanOrEqual(MAILBOX_BODY_LIMIT);
    const sent = (msg.meta as { items: number[] }).items;
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(10);
    // meta 里列的每一条都真的在正文里。
    for (const id of sent) expect(msg.body).toContain(`Finding ${s.items.get(id)!.body.split(".")[0].slice("Finding ".length)}.`);
  });

  it("closes open items when the PR is merged, and skips authors whose policy is off", async () => {
    const s = setup({ "comments.copilot": "off" });
    await s.observe();
    expect(s.items.byPr(s.row.id)).toEqual([]);
    const t = setup({}, { guardOk: false });
    await t.observe();
    await t.observe({ state: "MERGED" });
    expect(t.items.byPr(t.row.id)[0].state).toBe("closed");
  });
});
