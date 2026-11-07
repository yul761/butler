import { afterEach, describe, expect, it } from "vitest";
import type { ActivityKind } from "../../shared/activity";
import type { HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import { jobOf, type HeadlessExecDeps } from "../handoff/headless-exec";
import { setLang } from "../i18n";
import { fallbackNeedsYou, judgeNeedsYou, NEEDS_YOU_REPLY_CHARS, NeedsYouTracker, type NeedsYouVerdict } from "./needs-you";

function deps(out: HeadlessOutcome, seen: HeadlessRequest[] = [], labels: string[] = []): HeadlessExecDeps {
  return {
    run: async (req) => (seen.push(req), out),
    ready: async () => undefined,
    claude: () => ({ path: "/bin/claude", pathValue: "/bin" }),
    baseEnv: {},
    sessions: { recordHeadless: () => undefined } as unknown as HeadlessExecDeps["sessions"],
    now: () => 0,
    newRunId: () => "r",
    onUsage: (u) => labels.push(u.label),
  };
}
const usage = { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 };
const ok = (structured: unknown): HeadlessOutcome => ({
  ok: true,
  result: { sessionId: null, isError: false, subtype: null, resultText: "", structured, permissionDenials: [], apiErrorStatus: null, costUsd: null, usage, model: null },
});

afterEach(() => setLang("zh"));

describe("judgeNeedsYou", () => {
  it("asks Haiku with no tools, about the end of the reply only, and maps the answer", async () => {
    const seen: HeadlessRequest[] = [];
    const labels: string[] = [];
    const reply = `${"早".repeat(100)}${"中".repeat(NEEDS_YOU_REPLY_CHARS - 1)}要拆成两个 PR 吗？`;
    const v = await judgeNeedsYou(deps(ok({ needs_user: true, reason: "问要不要拆 PR" }), seen, labels), reply, "/repo");
    expect(v).toEqual({ needsYou: true, reason: "问要不要拆 PR" });
    const args = seen[0].args;
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
    expect(args).not.toContain("--allowedTools");
    expect(args).toContain("--json-schema");
    expect(seen[0].cwd).toBe("/repo");
    expect(seen[0].prompt).toContain("单纯汇报进度或结果");
    expect(seen[0].prompt).toContain("要拆成两个 PR 吗？");
    expect(seen[0].prompt).not.toContain("早");
    expect(seen[0].prompt).not.toContain("中".repeat(NEEDS_YOU_REPLY_CHARS));
    expect(labels).toEqual(["needs-you judge"]);
    expect(jobOf("needs-you judge")).toBe("needs-you judge");
  });

  it("writes the prompt in English when the app is in English", async () => {
    setLang("en");
    const seen: HeadlessRequest[] = [];
    await judgeNeedsYou(deps(ok({ needs_user: false, reason: "" }), seen), "Pushed.", "/repo");
    expect(seen[0].prompt).not.toMatch(/[一-鿿]/);
    expect(seen[0].prompt).toContain("needs_user");
    expect(seen[0].prompt).toContain("Pushed.");
  });

  it("cleans stray tags out of the reason (live finding: Haiku ended one with </reason></invoke>)", async () => {
    const v = await judgeNeedsYou(deps(ok({ needs_user: true, reason: "询问用户是否把改动拆成两个 PR，需要用户做决定</reason>\n</invoke>\n" })), "要拆吗？", "/r");
    expect(v).toEqual({ needsYou: true, reason: "询问用户是否把改动拆成两个 PR，需要用户做决定" });
    const long = await judgeNeedsYou(deps(ok({ needs_user: true, reason: `  ${"问".repeat(100)}  ` })), "要拆吗？", "/r");
    expect([...long!.reason]).toHaveLength(80);
  });

  it("returns null when the run fails or the answer is malformed", async () => {
    expect(await judgeNeedsYou(deps({ ok: false, reason: "timeout", message: "x", result: null }), "？", "/r")).toBeNull();
    expect(await judgeNeedsYou(deps(ok({ needs_user: "yes" })), "？", "/r")).toBeNull();
    expect(await judgeNeedsYou(deps(ok(null)), "？", "/r")).toBeNull();
  });
});

describe("fallbackNeedsYou", () => {
  it("falls back to a trailing question mark when the judge fails", () => {
    expect(fallbackNeedsYou("要拆成两个 PR 吗？").needsYou).toBe(true);
    expect(fallbackNeedsYou("推上去了。").needsYou).toBe(false);
  });

  it("looks past trailing Markdown, brackets and quotes for the question mark", () => {
    expect(fallbackNeedsYou("**要拆吗？**")).toEqual({ needsYou: true, reason: "要拆吗？" });
    expect(fallbackNeedsYou("做完了。**").needsYou).toBe(false);
    expect(fallbackNeedsYou("测试过了。`要合并吗?`\n")).toEqual({ needsYou: true, reason: "要合并吗?" });
    expect(fallbackNeedsYou("（要不要先 rebase？）").needsYou).toBe(true);
    expect(fallbackNeedsYou("他问「要合并吗？」").needsYou).toBe(true);
    expect(fallbackNeedsYou('Should I "merge it?"').needsYou).toBe(true);
    expect(fallbackNeedsYou("Done (see #12)").needsYou).toBe(false);
  });

  it("takes the last sentence as the reason, ignoring trailing blanks, at most 80 characters", () => {
    expect(fallbackNeedsYou("推上去了。要拆成两个 PR 吗？  \n")).toEqual({ needsYou: true, reason: "要拆成两个 PR 吗？" });
    expect(fallbackNeedsYou("Pushed. Should I merge it?")).toEqual({ needsYou: true, reason: "Should I merge it?" });
    expect(fallbackNeedsYou("测试都过了\n\n要合并吗??")).toEqual({ needsYou: true, reason: "要合并吗??" });
    expect(fallbackNeedsYou("Done.")).toEqual({ needsYou: false, reason: "" });
    const long = `${"长".repeat(100)}吗？`;
    expect([...fallbackNeedsYou(long).reason]).toHaveLength(80);
    expect(fallbackNeedsYou(long).reason.endsWith("吗？")).toBe(true);
  });
});

interface Head {
  id: string;
  cwd: string;
  waiting: boolean;
  kind: ActivityKind | null;
  reply: { id: string; text: string } | null;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 假 judge：每次调用都挂起，测试手动给结果。 */
function harness(heads: Head[]) {
  const calls: { reply: string; cwd: string; done: (v: NeedsYouVerdict | null) => void }[] = [];
  let notified = 0;
  const tracker = new NeedsYouTracker({
    judge: (reply, cwd) => {
      const d = deferred<NeedsYouVerdict | null>();
      calls.push({ reply, cwd, done: d.resolve });
      return d.promise;
    },
    sessions: () => heads,
    notify: () => notified++,
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { tracker, calls, heads, notified: () => notified, settle };
}

const stopped = (id: string, replyId: string, text: string): Head => ({ id, cwd: `/repo/${id}`, waiting: true, kind: "waiting", reply: { id: replyId, text } });

describe("NeedsYouTracker", () => {
  it("judges each reply id once", async () => {
    const h = harness([stopped("s1", "m1", "要拆成两个 PR 吗？")]);
    h.tracker.update();
    h.tracker.update();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ reply: "要拆成两个 PR 吗？", cwd: "/repo/s1" });
    h.calls[0].done({ needsYou: true, reason: "问要不要拆 PR" });
    await h.settle();
    h.tracker.update();
    expect(h.calls).toHaveLength(1);
    expect(h.tracker.reasonOf("s1")).toBe("问要不要拆 PR");
    expect(h.notified()).toBe(1);
    // 新的回复：重新判断，旧结论不再算数
    h.heads[0] = stopped("s1", "m2", "推上去了。");
    expect(h.tracker.reasonOf("s1")).toBeNull();
    h.tracker.update();
    expect(h.calls).toHaveLength(2);
  });

  it("undecided: stopped on a reply that is not judged yet (plan 16: auto refresh waits for the verdict)", async () => {
    const h = harness([stopped("s1", "m1", "推上去了。"), { id: "s2", cwd: "/r", waiting: false, kind: "edit", reply: { id: "x", text: "改着" } }]);
    // 还没 update 过、排着队、正在判断：都算没定。
    expect(h.tracker.undecided("s1")).toBe(true);
    h.tracker.update();
    expect(h.tracker.undecided("s1")).toBe(true);
    h.calls[0].done({ needsYou: false, reason: "" });
    await h.settle();
    expect(h.tracker.undecided("s1")).toBe(false);
    // 忙着的、没有回复的、不认识的：不算。
    expect(h.tracker.undecided("s2")).toBe(false);
    h.heads.push({ id: "s3", cwd: "/r", waiting: true, kind: "waiting", reply: null });
    expect(h.tracker.undecided("s3")).toBe(false);
    expect(h.tracker.undecided("nope")).toBe(false);
    // 新回复又停下：重新算没定。
    h.heads[0] = stopped("s1", "m2", "要拆吗？");
    expect(h.tracker.undecided("s1")).toBe(true);
  });

  it("a plain status report is not needs-you", async () => {
    const h = harness([stopped("s1", "m1", "推上去了，CI 在跑。")]);
    h.tracker.update();
    h.calls[0].done({ needsYou: false, reason: "" });
    await h.settle();
    expect(h.tracker.reasonOf("s1")).toBeNull();
    expect(h.notified()).toBe(0);
  });

  it("falls back to a trailing question mark when the judge fails, and does not judge that reply again", async () => {
    const h = harness([stopped("s1", "m1", "推上去了。要拆成两个 PR 吗？"), stopped("s2", "m2", "推上去了。")]);
    h.tracker.update();
    h.calls[0].done(null);
    h.calls[1].done(null);
    await h.settle();
    expect(h.tracker.reasonOf("s1")).toBe("要拆成两个 PR 吗？");
    expect(h.tracker.reasonOf("s2")).toBeNull();
    h.tracker.update();
    expect(h.calls).toHaveLength(2);
  });

  it("treats a judge that throws like a failed one", async () => {
    const logs: string[] = [];
    const heads = [stopped("s1", "m1", "要合并吗？")];
    const tracker = new NeedsYouTracker({ judge: () => Promise.reject(new Error("boom")), sessions: () => heads, notify: () => undefined, log: (m) => logs.push(m) });
    tracker.update();
    await new Promise((r) => setTimeout(r, 0));
    expect(tracker.reasonOf("s1")).toBe("要合并吗？");
    expect(logs).toHaveLength(1);
  });

  it("reasons() gives every needs-you session in one pass over the sessions", async () => {
    const heads = [stopped("s1", "m1", "要拆成两个 PR 吗？"), stopped("s2", "m2", "推上去了。"), { ...stopped("s3", "m3", "要合并吗？"), waiting: false }];
    let listed = 0;
    const tracker = new NeedsYouTracker({
      judge: (reply) => Promise.resolve({ needsYou: reply.endsWith("？"), reason: reply.endsWith("？") ? "问要不要拆 PR" : "" }),
      sessions: () => {
        listed++;
        return heads;
      },
      notify: () => undefined,
    });
    tracker.update();
    await new Promise((r) => setTimeout(r, 0));
    listed = 0;
    expect(tracker.reasons()).toEqual(new Map([["s1", "问要不要拆 PR"]]));
    expect(listed).toBe(1);
  });

  it("clears once the session is busy again", async () => {
    const h = harness([stopped("s1", "m1", "要拆成两个 PR 吗？")]);
    h.tracker.update();
    h.calls[0].done({ needsYou: true, reason: "问要不要拆 PR" });
    await h.settle();
    expect(h.tracker.reasonOf("s1")).toBe("问要不要拆 PR");
    h.heads[0] = { ...h.heads[0], waiting: false };
    expect(h.tracker.reasonOf("s1")).toBeNull();
    h.heads[0] = { ...h.heads[0], waiting: true, kind: "thinking" };
    expect(h.tracker.reasonOf("s1")).toBeNull();
    h.tracker.update();
    expect(h.calls).toHaveLength(1);
    // 终端关了
    h.heads.length = 0;
    expect(h.tracker.reasonOf("s1")).toBeNull();
  });

  it("does not bring back a question the user already answered when the next turn ends with no text", async () => {
    const h = harness([stopped("s1", "m1", "要拆成两个 PR 吗？")]);
    h.tracker.update();
    h.calls[0].done({ needsYou: true, reason: "问要不要拆 PR" });
    await h.settle();
    expect(h.tracker.reasonOf("s1")).toBe("问要不要拆 PR");
    // 用户回答了：忙起来，最后一条回复还是 m1
    h.heads[0] = { ...h.heads[0], waiting: false, kind: "edit" };
    h.tracker.update();
    // 这一轮没写文字就停了：还是 m1
    h.heads[0] = stopped("s1", "m1", "要拆成两个 PR 吗？");
    h.tracker.update();
    expect(h.tracker.reasonOf("s1")).toBeNull();
    expect(h.calls).toHaveLength(1);
    expect(h.notified()).toBe(1);
  });

  it("drops a queued judge for a reply answered before its turn came, and stays quiet if one was already running", async () => {
    const h = harness([stopped("s1", "m1", "一？"), stopped("s2", "m2", "二？"), stopped("s3", "m3", "三？")]);
    h.tracker.update();
    expect(h.calls).toHaveLength(2);
    h.heads[0] = { ...h.heads[0], waiting: false };
    h.heads[2] = { ...h.heads[2], waiting: false };
    h.tracker.update();
    h.calls[0].done({ needsYou: true, reason: "一" });
    h.calls[1].done({ needsYou: true, reason: "二" });
    await h.settle();
    expect(h.calls).toHaveLength(2);
    expect(h.notified()).toBe(1);
    h.heads[0] = stopped("s1", "m1", "一？");
    h.heads[2] = stopped("s3", "m3", "三？");
    h.tracker.update();
    expect(h.calls).toHaveLength(2);
    expect(h.tracker.reasonOf("s1")).toBeNull();
    expect(h.tracker.reasonOf("s2")).toBe("二");
    expect(h.tracker.reasonOf("s3")).toBeNull();
  });

  it("still judges a final reply first seen while the session was not yet marked stopped", async () => {
    const h = harness([{ ...stopped("s1", "m1", "要合并吗？"), waiting: false }]);
    h.tracker.update();
    h.heads[0] = stopped("s1", "m1", "要合并吗？");
    h.tracker.update();
    expect(h.calls).toHaveLength(1);
    h.calls[0].done({ needsYou: true, reason: "问要不要合并" });
    await h.settle();
    expect(h.tracker.reasonOf("s1")).toBe("问要不要合并");
  });

  it("only judges sessions that stopped with a reply", () => {
    const h = harness([
      { ...stopped("s1", "m1", "？"), waiting: false },
      { ...stopped("s2", "m2", "？"), kind: "approval" },
      { ...stopped("s3", "m3", "？"), reply: null },
      { ...stopped("s4", "m4", "？"), kind: null },
    ]);
    h.tracker.update();
    expect(h.calls).toHaveLength(0);
    expect(h.tracker.reasonOf("s3")).toBeNull();
  });

  it("gives the judge at most the last NEEDS_YOU_REPLY_CHARS characters", () => {
    const text = `${"早".repeat(10)}${"晚".repeat(NEEDS_YOU_REPLY_CHARS)}`;
    const h = harness([stopped("s1", "m1", text)]);
    h.tracker.update();
    expect(h.calls[0].reply).toBe("晚".repeat(NEEDS_YOU_REPLY_CHARS));
  });

  it("runs at most two judges at a time", async () => {
    const h = harness([stopped("s1", "m1", "一？"), stopped("s2", "m2", "二？"), stopped("s3", "m3", "三？")]);
    h.tracker.update();
    expect(h.calls).toHaveLength(2);
    h.tracker.update();
    expect(h.calls).toHaveLength(2);
    h.calls[0].done({ needsYou: true, reason: "一" });
    await h.settle();
    // 空出名额就接着判断，不等下一次 update
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].reply).toBe("三？");
    h.calls[1].done({ needsYou: false, reason: "" });
    h.calls[2].done({ needsYou: true, reason: "三" });
    await h.settle();
    expect(h.tracker.reasonOf("s3")).toBe("三");
  });

  it("drops a late verdict for a reply that has been replaced or a session that is gone", async () => {
    const h = harness([stopped("s1", "m1", "一？"), stopped("s2", "m2", "二？")]);
    h.tracker.update();
    h.heads[0] = stopped("s1", "m1b", "做完了。");
    h.heads.splice(1, 1);
    h.tracker.update();
    h.calls[0].done({ needsYou: true, reason: "旧的" });
    h.calls[1].done({ needsYou: true, reason: "走了" });
    await h.settle();
    expect(h.tracker.reasonOf("s1")).toBeNull();
    expect(h.notified()).toBe(0);
    // 新回复 m1b 在旧判断结束后排上
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].reply).toBe("做完了。");
  });

  describe("suppressNext (R35: the reply to Butler's own resume message)", () => {
    it("records the next new reply as not needs-you without calling the judge", async () => {
      // /clear 之后的新 head 还没有回复；Butler 输入接着做的话。
      const h = harness([{ id: "s1", cwd: "/repo/s1", waiting: false, kind: "thinking", reply: null }]);
      h.tracker.suppressNext("s1");
      h.tracker.update();
      // 它回了话（结尾还是个问句）：不判断，也不算需要你，也不算没判断完。
      h.heads[0] = stopped("s1", "m1", "做到第二步了。接下来要我做什么？");
      h.tracker.update();
      expect(h.calls).toHaveLength(0);
      expect(h.tracker.reasonOf("s1")).toBeNull();
      expect(h.tracker.undecided("s1")).toBe(false);
      // 只跳过这一条：之后的新回复照常判断。
      h.heads[0] = stopped("s1", "m2", "要拆成两个 PR 吗？");
      h.tracker.update();
      expect(h.calls).toHaveLength(1);
    });

    it("does not skip the reply the session was already stopped on", () => {
      const h = harness([stopped("s1", "m0", "旧的回复？")]);
      h.tracker.update();
      expect(h.calls).toHaveLength(1);
      h.tracker.suppressNext("s1");
      h.tracker.update();
      expect(h.calls).toHaveLength(1);
      h.heads[0] = stopped("s1", "m1", "接上了。");
      h.tracker.update();
      expect(h.calls).toHaveLength(1);
      expect(h.tracker.undecided("s1")).toBe(false);
    });

    it("forgets the skip when the session goes away", () => {
      const h = harness([{ id: "s1", cwd: "/repo/s1", waiting: false, kind: "thinking", reply: null }]);
      h.tracker.suppressNext("s1");
      h.heads.splice(0, 1);
      h.tracker.update();
      h.heads.push(stopped("s1", "m1", "要拆吗？"));
      h.tracker.update();
      expect(h.calls).toHaveLength(1);
    });
  });
});
