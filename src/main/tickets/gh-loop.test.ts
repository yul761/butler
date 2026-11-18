import { describe, expect, it } from "vitest";
import { parseReviewThreads, parseRunInfo } from "./gh-loop";

describe("parseReviewThreads", () => {
  it("reads threads with their comments", () => {
    const text = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [
        {
          id: "T1", isResolved: false, isOutdated: true, path: "src/a.ts", line: null, originalLine: 12,
          comments: { nodes: [
            { databaseId: 101, author: { __typename: "Bot", login: "copilot-pull-request-reviewer" }, body: "Use const", createdAt: "2026-01-01T00:00:00Z", url: "u1", path: "src/a.ts", line: null, originalLine: 12, commit: { oid: "abc" } },
            { databaseId: null, body: "bad" },
          ] },
        },
        { id: "T2", comments: { nodes: [] } },
        { nope: 1 },
      ] } } } },
    });
    expect(parseReviewThreads(text)).toEqual([
      {
        id: "T1", isResolved: false, isOutdated: true, path: "src/a.ts", line: null, originalLine: 12,
        comments: [{ databaseId: 101, author: "copilot-pull-request-reviewer", authorType: "Bot", body: "Use const", createdAt: "2026-01-01T00:00:00Z", url: "u1", path: "src/a.ts", line: null, originalLine: 12, commit: "abc" }],
      },
    ]);
  });

  it("returns null for errors and bad output", () => {
    expect(parseReviewThreads(null)).toBeNull();
    expect(parseReviewThreads("nope")).toBeNull();
    expect(parseReviewThreads(JSON.stringify({ errors: [{ message: "x" }] }))).toBeNull();
  });
});

describe("parseRunInfo", () => {
  it("lowercases states and reads steps", () => {
    const info = parseRunInfo(JSON.stringify({
      attempt: 2, status: "COMPLETED", conclusion: "FAILURE",
      jobs: [{ name: "test", status: "completed", conclusion: "failure", startedAt: "s", completedAt: "c", steps: [{ name: "Install", conclusion: "FAILURE", number: 3 }] }, { name: "empty", steps: [] }],
    }));
    expect(info).toEqual({
      attempt: 2, status: "completed", conclusion: "failure",
      jobs: [
        { name: "test", status: "completed", conclusion: "failure", startedAt: "s", completedAt: "c", steps: [{ name: "Install", conclusion: "failure", number: 3 }] },
        { name: "empty", status: "", conclusion: "", startedAt: null, completedAt: null, steps: [] },
      ],
    });
    expect(parseRunInfo("[]")).toBeNull();
    expect(parseRunInfo(JSON.stringify({}))?.attempt).toBe(1);
  });
});
