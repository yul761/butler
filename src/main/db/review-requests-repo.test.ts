import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { ReviewRequestsRepo } from "./review-requests-repo";

const A = { url: "https://github.com/o/a/pull/1", slug: "o/a", number: 1, title: "A", author: "amy" };
const B = { url: "https://github.com/o/b/pull/2", slug: "o/b", number: 2, title: "B", author: "bob" };
const C = { url: "https://GHE.co/o/c/pull/3", slug: "ghe.co/o/c", number: 3, title: "C", author: "cat" };

describe("ReviewRequestsRepo", () => {
  it("replaces the list as a whole, keeping first_seen_at for PRs still requested", () => {
    const repo = new ReviewRequestsRepo(memDb());
    repo.replaceAll([A, B], 100);
    expect(repo.list().map((r) => [r.number, r.firstSeenAt])).toEqual([[1, 100], [2, 100]]);
    repo.replaceAll([{ ...B, title: "B2" }, C], 200);
    expect(repo.list()).toEqual([
      { ...B, title: "B2", firstSeenAt: 100, lastSeenAt: 200 },
      { ...C, firstSeenAt: 200, lastSeenAt: 200 },
    ]);
    // 被重新请 review：从头算
    repo.replaceAll([A], 300);
    expect(repo.list()).toEqual([{ ...A, firstSeenAt: 300, lastSeenAt: 300 }]);
    repo.replaceAll([], 400);
    expect(repo.list()).toEqual([]);
  });
});
