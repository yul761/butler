import { describe, expect, it } from "vitest";
import { botReviewCommands, requestBotReview, requestBotReviewGuarded, reviewCommentCount, type GhRun } from "./bot-review";

type R = Awaited<ReturnType<GhRun>>;
const ok: R = { stdout: "{}", stderr: "" };
const fail = (stderr: string, timedOut = false): R => ({ stdout: null, stderr, timedOut });

function runner(answers: R[]) {
  const calls: string[][] = [];
  const run: GhRun = async (_cwd, args) => {
    calls.push(args);
    return answers.shift() ?? fail("no more answers");
  };
  return { run, calls };
}

const target = { cwd: "/r", slug: "o/r", number: 12, bot: "copilot" as const };

describe("requestBotReview", () => {
  it("uses the Copilot review endpoint first", async () => {
    const r = runner([ok]);
    expect(await requestBotReview(r.run, target)).toEqual({ ok: true, via: "api" });
    expect(r.calls).toEqual([["api", "-X", "POST", "repos/o/r/pulls/12/copilot-code-review"]]);
  });

  it("treats 409 as already requested", async () => {
    const r = runner([fail("gh: A Copilot review is already pending (HTTP 409)")]);
    expect(await requestBotReview(r.run, target)).toEqual({ ok: true, via: "api_pending" });
  });

  it("falls back to requested_reviewers, then gh pr edit", async () => {
    const r = runner([fail("gh: Not Found (HTTP 404)"), fail("gh: Validation Failed (HTTP 422)"), ok]);
    expect(await requestBotReview(r.run, target)).toEqual({ ok: true, via: "pr_edit" });
    expect(r.calls[1]).toEqual(["api", "-X", "POST", "repos/o/r/pulls/12/requested_reviewers", "-f", "reviewers[]=copilot-pull-request-reviewer[bot]"]);
    expect(r.calls[2]).toEqual(["pr", "edit", "12", "-R", "o/r", "--add-reviewer", "@copilot"]);
  });

  it("a timeout everywhere is a failure, not a request", async () => {
    const r = runner([fail("", true), fail("", true), fail("", true)]);
    expect(await requestBotReview(r.run, target)).toEqual({ ok: false, error: "timed out" });
  });

  it("asks Codex with a PR comment and passes the GHE host to gh api", async () => {
    const r = runner([ok]);
    expect(await requestBotReview(r.run, { ...target, bot: "codex" })).toEqual({ ok: true, via: "comment" });
    expect(r.calls[0]).toEqual(["pr", "comment", "12", "-R", "o/r", "--body", "@codex review"]);
    const g = runner([ok]);
    await requestBotReview(g.run, { ...target, slug: "ghe.example.com/o/r" });
    expect(g.calls[0]).toEqual(["api", "--hostname", "ghe.example.com", "-X", "POST", "repos/o/r/pulls/12/copilot-code-review"]);
    expect(botReviewCommands("ghe.example.com/o/r", 12, "copilot")[0]).toBe("gh api --hostname ghe.example.com -X POST repos/o/r/pulls/12/copilot-code-review");
  });
});

describe("reviewCommentCount (BTL-273)", () => {
  it("adds up the inline comments of each review", async () => {
    const r = runner([{ stdout: "2\n", stderr: "" }, { stdout: "0", stderr: "" }]);
    expect(await reviewCommentCount(r.run, { cwd: "/r", slug: "h.example/o/r", number: 12 }, ["11", "12"])).toBe(2);
    expect(r.calls).toEqual([
      ["api", "--hostname", "h.example", "repos/o/r/pulls/12/reviews/11/comments", "--paginate", "--jq", "length"],
      ["api", "--hostname", "h.example", "repos/o/r/pulls/12/reviews/12/comments", "--paginate", "--jq", "length"],
    ]);
  });

  it("is null (not zero) when any fetch fails, times out or prints something odd", async () => {
    expect(await reviewCommentCount(runner([fail("HTTP 502")]).run, { cwd: "/r", slug: "o/r", number: 1 }, ["1"])).toBeNull();
    expect(await reviewCommentCount(runner([{ stdout: "0", stderr: "" }, fail("", true)]).run, { cwd: "/r", slug: "o/r", number: 1 }, ["1", "2"])).toBeNull();
    expect(await reviewCommentCount(runner([{ stdout: "oops", stderr: "" }]).run, { cwd: "/r", slug: "o/r", number: 1 }, ["1"])).toBeNull();
  });
});

describe("requestBotReviewGuarded (BTL-273)", () => {
  const target = { cwd: "/w", slug: "o/a", number: 5, bot: "codex" as const, ticketKey: "X-1", url: "https://github.com/o/a/pull/5" };
  function external(allowed: boolean) {
    const audit: { kind: string; outcome: string; error?: string; target: string | null }[] = [];
    return {
      audit,
      async attempt<T>(kind: "pr_review_request", detail: { target: string | null }, run: () => Promise<T>) {
        if (!allowed) return (audit.push({ kind, outcome: "skipped", target: detail.target }), { ran: false as const });
        try {
          const value = await run();
          audit.push({ kind, outcome: "done", target: detail.target });
          return { ran: true as const, value };
        } catch (e) {
          audit.push({ kind, outcome: "failed", error: (e as Error).message, target: detail.target });
          throw e;
        }
      },
    };
  }

  it("with the switch off it doesn't call gh, says off, and audits a skip", async () => {
    const x = external(false);
    let calls = 0;
    const r = await requestBotReviewGuarded(x, target, async () => (calls++, { ok: true, via: "comment" }));
    expect(r).toMatchObject({ ok: false, off: true });
    expect(calls).toBe(0);
    expect(x.audit).toEqual([{ kind: "pr_review_request", outcome: "skipped", target: target.url }]);
  });

  it("with it on, a request that went through is audited done; one that failed is audited failed and keeps gh's error", async () => {
    const on = external(true);
    expect(await requestBotReviewGuarded(on, target, async () => ({ ok: true, via: "comment" }))).toEqual({ ok: true, via: "comment" });
    expect(await requestBotReviewGuarded(on, target, async () => ({ ok: false, error: "HTTP 422" }))).toEqual({ ok: false, error: "HTTP 422" });
    expect(await requestBotReviewGuarded(on, target, async () => Promise.reject(new Error("spawn gh ENOENT\nmore")))).toEqual({ ok: false, error: "spawn gh ENOENT" });
    expect(on.audit.map((a) => a.outcome)).toEqual(["done", "failed", "failed"]);
    expect(on.audit[1].error).toBe("HTTP 422");
  });
});
