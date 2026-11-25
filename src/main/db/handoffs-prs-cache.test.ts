import { describe, expect, it } from "vitest";
import { upgradeLegacyPr, type Handoff, type Pr } from "../../shared/handoff";
import { dedupeHandoffPrs, rememberMergedPrs } from "../../shared/pr-memory";
import { emptyHandoff } from "../handoff/schema";
import { insertTicket, memDb } from "../test-utils";
import type { Db } from "./database";
import { HandoffsRepo } from "./handoffs-repo";
import { RepoRenamesRepo } from "./repo-renames-repo";
import { bumpTableGen } from "./table-gen";
import { TicketsRepo } from "./tickets-repo";

// knownPrs / allPrs 改成只取 prs、按 ticket 缓存（BTL-265）：结果要和原来的（SELECT * 再整个 JSON.parse）一样。
function reference(db: Db, key: string): { known: Pr[]; all: Pr[] } {
  const rows = db
    .prepare(`SELECT payload FROM handoffs WHERE ticket_key = ? AND degraded = 0 AND payload IS NOT NULL ORDER BY created_at DESC, id DESC`)
    .all(key) as { payload: string }[];
  const lists: Pr[][] = [];
  for (const r of rows) {
    let h: Handoff | null;
    try {
      h = upgradeLegacyPr(JSON.parse(r.payload)) as Handoff;
    } catch {
      h = null;
    }
    if (h?.prs) lists.push(h.prs);
  }
  return { known: lists.length === 0 ? [] : rememberMergedPrs(lists[0], lists.slice(1)), all: dedupeHandoffPrs(lists.flat()) };
}

const pr = (number: number, state: Pr["state"] = "open", repo = "a/x"): Pr => ({ number, url: `https://github.com/${repo}/pull/${number}`, state, review: null });

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  for (const key of ["T-1", "T-2"]) {
    insertTicket(tickets, { key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: `feature/${key}`, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  }
  const repo = new HandoffsRepo(db);
  const raw = (key: string, createdAt: number, payload: string, degraded = 0) =>
    db.prepare(`INSERT INTO handoffs (ticket_key, trigger, created_at, payload, degraded, raw_text) VALUES (?, 'command', ?, ?, ?, 'x')`).run(key, createdAt, payload, degraded);
  const add = (key: string, createdAt: number, prs: Pr[]) =>
    repo.insert({ ticketKey: key, sessionId: null, trigger: "command", createdAt, payload: { ...emptyHandoff(key), prs }, rawText: "raw ".repeat(100) });
  return { db, repo, raw, add };
}

describe("HandoffsRepo PR cache (BTL-265)", () => {
  it("matches parsing whole payloads, including legacy single-pr payloads and rows that do not parse", () => {
    const { db, repo, raw, add } = setup();
    add("T-1", 100, [pr(1, "merged"), pr(2)]);
    raw("T-1", 150, JSON.stringify({ ...emptyHandoff("T-1"), prs: undefined, pr: pr(3, "merged") }));
    raw("T-1", 160, JSON.stringify({ ticket: "T-1", pr: null }));
    raw("T-1", 170, "{broken");
    raw("T-1", 180, "[1, 2]");
    raw("T-1", 185, "7");
    raw("T-1", 190, JSON.stringify({ ticket: "T-1", prs: null }));
    raw("T-1", 195, JSON.stringify({ ticket: "T-1" }));
    raw("T-1", 197, JSON.stringify({ ticket: "T-1", prs: [pr(9, "merged")] }), 1);
    add("T-1", 200, [pr(2), pr(4)]);
    add("T-2", 100, [pr(7)]);
    for (const key of ["T-1", "T-2", "NONE"]) {
      const want = reference(db, key);
      expect(repo.knownPrs(key)).toEqual(want.known);
      expect(repo.allPrs(key)).toEqual(want.all);
    }
    expect(repo.knownPrs("T-1").map((p) => [p.number, p.state])).toEqual([[2, "open"], [4, "open"], [3, "merged"], [1, "merged"]]);
  });

  it("sees a new handoff right away", () => {
    const { repo, add } = setup();
    add("T-1", 100, [pr(1)]);
    expect(repo.knownPrs("T-1").map((p) => p.state)).toEqual(["open"]);
    // 时间比已有的早也一样（按行数和最大 id 认）。
    add("T-1", 50, [pr(1, "merged")]);
    expect(repo.knownPrs("T-1").map((p) => p.state)).toEqual(["merged"]);
    add("T-1", 300, [pr(1), pr(5)]);
    expect(repo.allPrs("T-1").map((p) => p.number)).toEqual([1, 5]);
  });

  it("sees an in-place rewrite once the table generation is bumped, and a repo rename bumps it", () => {
    const { db, repo, add } = setup();
    add("T-1", 100, [pr(1, "open", "o/old")]);
    expect(repo.knownPrs("T-1")[0].url).toBe("https://github.com/o/old/pull/1");
    db.prepare(`UPDATE handoffs SET payload = replace(payload, 'o/old', 'o/mid')`).run();
    bumpTableGen(db, "handoffs");
    expect(repo.knownPrs("T-1")[0].url).toBe("https://github.com/o/mid/pull/1");
    const renames = new RepoRenamesRepo(db);
    renames.record("o/mid", "o/new", "scan", 1);
    renames.applyAll(10);
    expect(repo.knownPrs("T-1")[0].url).toBe("https://github.com/o/new/pull/1");
    expect(repo.allPrs("T-1")[0].url).toBe("https://github.com/o/new/pull/1");
  });

  it("hands out copies: changing a result does not change the next one", () => {
    const { repo, add } = setup();
    add("T-1", 100, [pr(1)]);
    const a = repo.knownPrs("T-1");
    a[0].state = "closed";
    a.push(pr(2));
    const b = repo.allPrs("T-1");
    b[0].number = 99;
    expect(repo.knownPrs("T-1")).toEqual([pr(1)]);
    expect(repo.allPrs("T-1")).toEqual([pr(1)]);
  });
});
