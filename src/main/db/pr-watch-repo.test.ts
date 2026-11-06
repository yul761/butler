import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memDb, tempDir } from "../test-utils";
import { openDatabase, type Db } from "./database";
import { PrWatchRepo, type PrWatchRow } from "./pr-watch-repo";
import { TicketsRepo } from "./tickets-repo";

/** 建 ticket 和仓库，返回 repoId（pr_watch 外键指向 ticket_repos）。 */
function addRepo(db: Db, key: string, path = "/r"): number {
  const tickets = new TicketsRepo(db);
  tickets.insert({ key, title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  return tickets.addRepo({ ticketKey: key, repoPath: path, workMode: "branch", worktreePath: null, branch: `b-${key}`, createdAt: 1 });
}

const row = (repoId: number, o: Partial<PrWatchRow> = {}): Omit<PrWatchRow, "deliveredKey"> => ({
  ticketKey: "BTL-1", repoId, repoPath: "/r", branch: "b-BTL-1", number: 7, url: "https://x/pull/7", state: "open", review: "pending",
  ci: "failing", headSha: "abc", checkedAt: 100, failed: [{ name: "test", state: "failing", runId: 9, log: "boom" }], ...o,
});

describe("PrWatchRepo", () => {
  it("upserts without touching the delivered key", () => {
    const db = memDb();
    const id = addRepo(db, "BTL-1");
    const repo = new PrWatchRepo(db);
    repo.upsert(row(id));
    repo.setDelivered(id, "sha1:test");
    repo.upsert(row(id, { ci: "passing", failed: [], checkedAt: 200 }));
    expect(repo.get(id)).toMatchObject({ ci: "passing", failed: [], checkedAt: 200, deliveredKey: "sha1:test" });
  });

  it("delivered key survives a reopen", () => {
    const file = join(tempDir("pr-watch"), "b.db");
    const db = openDatabase(file);
    const id = addRepo(db, "BTL-1");
    const repo = new PrWatchRepo(db);
    repo.upsert(row(id));
    repo.setDelivered(id, "k1");
    db.close();
    const again = new PrWatchRepo(openDatabase(file));
    expect(again.get(id)).toMatchObject({ deliveredKey: "k1", failed: [{ name: "test", runId: 9, log: "boom" }] });
  });

  it("lists by ticket, lists all, and removes", () => {
    const db = memDb();
    const a = addRepo(db, "BTL-1");
    const b = addRepo(db, "BTL-2", "/s");
    const repo = new PrWatchRepo(db);
    repo.upsert(row(a));
    repo.upsert(row(b, { ticketKey: "BTL-2", number: null, url: null, state: null, review: null, ci: "none", headSha: null, failed: [] }));
    expect(repo.byTicket("BTL-2").map((r) => r.repoId)).toEqual([b]);
    expect(repo.byTicket("BTL-2")[0]).toMatchObject({ number: null, state: null, deliveredKey: null });
    expect(repo.all().map((r) => r.repoId)).toEqual([a, b]);
    repo.remove(a);
    expect(repo.get(a)).toBeNull();
  });
});
