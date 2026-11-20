import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { migrate } from "./database";
import { ForkDiscussionsRepo } from "./fork-discussions-repo";
import { MIGRATIONS } from "./migrations";

const base = { rootSessionId: "root-1", mode: "full" as const, ticketKey: "BTL-1", featureId: null, cwd: "/w", launchArgs: ["--model", "opus", "-p"], at: 1000 };
const setup = () => {
  const db = memDb();
  return { db, repo: new ForkDiscussionsRepo(db) };
};

describe("fork_discussions 表", () => {
  it("has every column", () => {
    const { db } = setup();
    const cols = (db.prepare("PRAGMA table_info(fork_discussions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      "id", "root_session_id", "fork_session_id", "mode", "cost_usd", "cost_partial", "started_at", "last_at", "summary_sent_at",
      "ticket_key", "feature_id", "cwd", "launch_args", "status", "error_code", "error_reset_at", "conclusion", "conclusion_at", "reask_of",
    ]);
  });

  it("upgrades an old database without losing data", () => {
    const n = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE fork_discussions")) + 1;
    expect(n).toBeGreaterThan(0);
    const db = new DatabaseSync(":memory:");
    for (let i = 0; i < n - 1; i++) db.exec(MIGRATIONS[i]);
    db.exec(`PRAGMA user_version = ${n - 1}`);
    db.prepare(
      "INSERT INTO session_usage (message_id, source, at, input, cache_write_5m, cache_write_1h, cache_read, output, context) VALUES ('m', 'session', 1, 1, 0, 0, 0, 1, 1)",
    ).run();
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS c FROM session_usage").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM fork_discussions").get()).toEqual({ c: 0 });
  });
});

describe("ForkDiscussionsRepo", () => {
  it("create starts running with unknown cost and round-trips launch args", () => {
    const { repo } = setup();
    const row = repo.create(base);
    expect(row.status).toBe("running");
    expect(row.costUsd).toBeNull();
    expect(row.costPartial).toBe(false);
    expect(row.launchArgs).toEqual(["--model", "opus", "-p"]);
    expect(row.startedAt).toBe(1000);
    expect(repo.get(row.id)).toEqual(row);
    expect(repo.get(999)).toBeNull();
  });

  it("start is an atomic guard against double clicks", () => {
    const { repo } = setup();
    const { id } = repo.create(base);
    expect(repo.start(id, 1100)).toBe(false);
    repo.finish(id, { at: 1200, addCost: 0.01, partial: false });
    expect(repo.start(id, 1300)).toBe(true);
    expect(repo.get(id)?.status).toBe("running");
    expect(repo.get(id)?.lastAt).toBe(1300);
  });

  it("start on a failed row restarts it and clears the old error", () => {
    const { repo } = setup();
    const { id } = repo.create(base);
    repo.finish(id, { at: 1, addCost: null, partial: true, error: { code: "timeout", resetAt: 9 } });
    expect(repo.start(id, 2)).toBe(true);
    expect(repo.get(id)).toMatchObject({ status: "running", errorCode: null, errorResetAt: null });
  });

  it("finish accumulates cost", () => {
    const { repo } = setup();
    const { id } = repo.create(base);
    repo.finish(id, { at: 1, addCost: 0.02, partial: false });
    repo.finish(id, { at: 2, addCost: 0.02, partial: false });
    const row = repo.get(id)!;
    expect(row.costUsd).toBeCloseTo(0.04);
    expect(row.costPartial).toBe(false);
    expect(row.status).toBe("idle");
    expect(row.lastAt).toBe(2);
  });

  it("finish keeps cost NULL while no turn is priced and flags partial", () => {
    const { repo } = setup();
    const { id } = repo.create(base);
    repo.finish(id, { at: 1, addCost: null, partial: true });
    expect(repo.get(id)?.costUsd).toBeNull();
    expect(repo.get(id)?.costPartial).toBe(true);
    repo.finish(id, { at: 2, addCost: 0.01, partial: false });
    expect(repo.get(id)?.costUsd).toBeCloseTo(0.01);
    expect(repo.get(id)?.costPartial).toBe(true);
  });

  it("finish with error fails the row and the next clean finish clears the error", () => {
    const { repo } = setup();
    const { id } = repo.create(base);
    repo.finish(id, { at: 1, addCost: null, partial: true, error: { code: "rate_limited", resetAt: 5000 } });
    let row = repo.get(id)!;
    expect(row.status).toBe("failed");
    expect(row.errorCode).toBe("rate_limited");
    expect(row.errorResetAt).toBe(5000);
    repo.finish(id, { at: 2, addCost: 0.01, partial: false });
    row = repo.get(id)!;
    expect(row.status).toBe("idle");
    expect(row.errorCode).toBeNull();
    expect(row.errorResetAt).toBeNull();
  });

  it("forkSessionId is only written when given", () => {
    const { repo } = setup();
    const { id } = repo.create(base);
    repo.finish(id, { at: 1, forkSessionId: "fork-1", addCost: 0.01, partial: false });
    repo.finish(id, { at: 2, addCost: 0.01, partial: false });
    expect(repo.get(id)?.forkSessionId).toBe("fork-1");
  });

  it("setConclusion and markSent", () => {
    const { repo } = setup();
    const { id } = repo.create(base);
    repo.setConclusion(id, "do X", 50);
    repo.markSent(id, 60);
    const row = repo.get(id)!;
    expect(row.conclusion).toBe("do X");
    expect(row.conclusionAt).toBe(50);
    expect(row.summarySentAt).toBe(60);
  });

  it("failRunning only touches running rows and counts them", () => {
    const { repo } = setup();
    const a = repo.create(base);
    const b = repo.create({ ...base, at: 2000 });
    repo.finish(b.id, { at: 2100, addCost: 0.01, partial: false });
    expect(repo.failRunning("interrupted", 3000)).toBe(1);
    expect(repo.get(a.id)).toMatchObject({ status: "failed", errorCode: "interrupted", lastAt: 3000 });
    expect(repo.get(b.id)?.status).toBe("idle");
    expect(repo.failRunning("interrupted", 4000)).toBe(0);
  });

  it("failRunning marks the cost partial (a run killed mid-turn may have spent tokens) and keeps the known part", () => {
    const { repo } = setup();
    const a = repo.create(base);
    repo.finish(a.id, { at: 1100, addCost: 0.02, partial: false });
    expect(repo.start(a.id, 1200)).toBe(true);
    const idle = repo.create({ ...base, at: 2000 });
    repo.finish(idle.id, { at: 2100, addCost: 0.01, partial: false });
    repo.failRunning("interrupted", 3000);
    expect(repo.get(a.id)).toMatchObject({ status: "failed", costUsd: 0.02, costPartial: true });
    expect(repo.get(idle.id)).toMatchObject({ costUsd: 0.01, costPartial: false });
  });

  it("listByRoot returns only that root, oldest first", () => {
    const { repo } = setup();
    const late = repo.create({ ...base, at: 3000 });
    const early = repo.create({ ...base, at: 2000 });
    repo.create({ ...base, rootSessionId: "other" });
    expect(repo.listByRoot("root-1").map((r) => r.id)).toEqual([early.id, late.id]);
  });

  it("runningReaskOf finds a running re-ask of a row", () => {
    const { repo } = setup();
    const orig = repo.create(base);
    expect(repo.runningReaskOf(orig.id)).toBeNull();
    const re = repo.create({ ...base, reaskOf: orig.id });
    expect(repo.runningReaskOf(orig.id)?.id).toBe(re.id);
    repo.finish(re.id, { at: 2, addCost: 0.01, partial: false });
    expect(repo.runningReaskOf(orig.id)).toBeNull();
  });
});
