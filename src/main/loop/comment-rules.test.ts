import { describe, expect, it } from "vitest";
import { candidates, classifyCommentByRule, isAck, whoOf, type Candidate } from "./comment-rules";
import type { ReviewThread } from "../tickets/gh-loop";

const thread = (over: Partial<ReviewThread> = {}, comments: Partial<ReviewThread["comments"][number]>[] = [{}]): ReviewThread => ({
  id: "T1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 12, originalLine: 12,
  comments: comments.map((c, i) => ({ databaseId: 100 + i, author: "Copilot", authorType: "Bot", body: "Rename this", createdAt: "2026-01-01T00:00:00Z", url: `u${i}`, path: "src/a.ts", line: 12, originalLine: 12, commit: "c", ...c })),
  ...over,
});
const cand = (over: Partial<Candidate> = {}): Candidate => ({
  key: "1", kind: "inline", threadId: "T", databaseId: 1, author: "Copilot", who: "copilot", path: "a.ts", line: 3, body: "Rename x to y", url: null, commentedAt: 0,
  isResolved: false, isOutdated: false, followUps: [], ...over,
});

describe("candidates", () => {
  it("turns threads, reviews with a body and PR comments into candidates", () => {
    const pr = {
      author: "me",
      reviews: [
        { id: "R1", author: "alice", state: "CHANGES_REQUESTED" as const, body: "Please split this", submittedAt: 5 },
        { id: "R2", author: "alice", state: "APPROVED" as const, body: "", submittedAt: 6 },
        { id: "R3", author: "alice", state: "PENDING" as const, body: "draft", submittedAt: 7 },
      ],
      comments: [{ id: "IC1", author: "bob", body: "Why not reuse X?", createdAt: 8, url: "iu", path: null, line: null, reviewId: null }],
    };
    const got = candidates(pr, [thread({}, [{}, { author: "me", authorType: "User", body: "Done" }])]);
    expect(got.map((c) => [c.key, c.kind, c.who])).toEqual([["100", "inline", "copilot"], ["review:R1", "review", "human"], ["issue:IC1", "issue", "human"]]);
    expect(got[0]).toMatchObject({ path: "src/a.ts", line: 12, threadId: "T1", followUps: [{ author: "me", who: "author", body: "Done" }], commentedAt: Date.parse("2026-01-01T00:00:00Z") });
  });

  it("calls non-Copilot bots bots", () => {
    expect(whoOf("coverage-bot", "me", "Bot")).toBe("bot");
    expect(whoOf("copilot-pull-request-reviewer", "me", "Bot")).toBe("copilot");
    expect(whoOf("me", "me")).toBe("author");
  });
});

describe("classifyCommentByRule", () => {
  it("skips resolved threads, own comments and other bots", () => {
    expect(classifyCommentByRule(cand({ isResolved: true }), [])).toEqual({ skip: true, reason: "resolved" });
    expect(classifyCommentByRule(cand({ who: "author" }), [])).toEqual({ skip: true, reason: "own" });
    expect(classifyCommentByRule(cand({ who: "bot" }), [])).toEqual({ skip: true, reason: "bot" });
  });

  it("ignores outdated, answered, acknowledgements, Copilot overviews and patterns", () => {
    expect(classifyCommentByRule(cand({ isOutdated: true }), [])).toEqual({ skip: false, category: "ignore", reason: "outdated" });
    expect(classifyCommentByRule(cand({ line: null }), [])).toMatchObject({ reason: "outdated" });
    expect(classifyCommentByRule(cand({ followUps: [{ author: "me", who: "author", body: "Fixed" }] }), [])).toMatchObject({ reason: "answered" });
    expect(classifyCommentByRule(cand({ body: "LGTM!" }), [])).toMatchObject({ reason: "ack" });
    expect(classifyCommentByRule(cand({ kind: "review", line: null, body: "## Pull Request Overview\nThis PR adds…" }), [])).toMatchObject({ reason: "overview" });
    expect(classifyCommentByRule(cand({ body: "nit: spacing" }), ["nit:"])).toMatchObject({ category: "ignore", reason: "pattern" });
  });

  it("treats suggestion blocks as fixes and leaves the rest to the model", () => {
    expect(classifyCommentByRule(cand({ body: "Try:\n```suggestion\nconst x = 1;\n```" }), [])).toEqual({ skip: false, category: "fix", reason: "suggestion" });
    expect(classifyCommentByRule(cand(), [])).toBeNull();
    expect(classifyCommentByRule(cand({ kind: "issue", line: null, path: null, who: "human", body: "Why this approach?" }), [])).toBeNull();
  });

  it("recognises acknowledgements", () => {
    for (const b of ["", "👍", "thanks", "Looks good to me.", "谢谢", ":+1:"]) expect(isAck(b)).toBe(true);
    expect(isAck("thanks, but please rename x")).toBe(false);
  });
});
