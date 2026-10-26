import { describe, expect, it } from "vitest";
import type { SessionView, TicketRepo } from "../../shared/types";
import { lastSegment, repoWhere, scanToSelection, sessionPlace } from "./repos";

const repo = (id: number, path: string, extra: Partial<TicketRepo> = {}): TicketRepo => ({
  id, ticketKey: "P-1", repoPath: path, workMode: "branch", worktreePath: null, branch: "feature/P-1", createdAt: 1, worktreeRemovedAt: null, cleanupBlocked: null, ...extra,
});
const session = (extra: Partial<SessionView>): SessionView => ({
  id: "s", ticketKey: "P-1", cwd: "/x", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null, waitingForInput: false,
  replacedBy: null, dismissed: false, createdAt: 1, repoId: null, coordinator: false, spawnedBy: null, featureId: null, termId: null, ...extra,
});

describe("repo labels", () => {
  it("takes the last path segment with either separator", () => {
    expect(lastSegment("/a/b/web")).toBe("web");
    expect(lastSegment("C:\\code\\api\\")).toBe("api");
  });

  it("shows the worktree, or the repo and its branch", () => {
    expect(repoWhere(repo(1, "/c/web", { workMode: "worktree", worktreePath: "/c/web-worktrees/P-1" }))).toBe("/c/web-worktrees/P-1");
    expect(repoWhere(repo(1, "/c/web"))).toBe("/c/web @ feature/P-1");
  });

  it("labels sessions by repo only when the ticket has several, and always labels the coordinator", () => {
    const repos = [repo(1, "/c/web"), repo(2, "/c/api")];
    expect(sessionPlace(session({ repoId: 2 }), repos, "总控")).toBe("api");
    expect(sessionPlace(session({ coordinator: true }), repos, "总控")).toBe("总控");
    expect(sessionPlace(session({ repoId: 1 }), [repos[0]], "总控")).toBeNull();
    expect(sessionPlace(session({ repoId: null }), repos, "总控")).toBeNull();
  });
});

describe("scanToSelection (design 2026-10-26)", () => {
  it("uses the repo root for a repo", () => {
    expect(scanToSelection({ kind: "repo", root: "/c/shop/frontend" }, "/c/shop/frontend/src")).toEqual({ paths: ["/c/shop/frontend"], options: null, notFound: false });
  });
  it("offers every repo of a parent directory, all picked", () => {
    expect(scanToSelection({ kind: "parent", repos: ["/c/shop/a", "/c/shop/b"] }, "/c/shop")).toEqual({ paths: ["/c/shop/a", "/c/shop/b"], options: ["/c/shop/a", "/c/shop/b"], notFound: false });
  });
  it("keeps what was typed when nothing is found, so the main process reports why", () => {
    expect(scanToSelection({ kind: "none" }, "/tmp/x")).toEqual({ paths: ["/tmp/x"], options: null, notFound: true });
  });
});
