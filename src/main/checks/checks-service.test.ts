import { describe, expect, it } from "vitest";
import { BacktestRepo } from "../db/backtest-repo";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { LessonBatchService } from "../lessons/lesson-batches";
import { ChecksService } from "./checks-service";
import { CHECKS_SNAPSHOT_VERSION, type CheckInput, type CheckLogRecord } from "../../shared/checks";

const fp = (pattern: string, over: Partial<CheckInput> = {}): CheckInput => ({
  type: "forbidden_pattern", name: "no foo", params: { pattern }, globs: ["src/**"], excludeGlobs: [], severity: "block", mode: "enforce", enabled: true, message: "", ...over,
});

const setup = () => {
  const db = memDb();
  const lessons = new LessonsRepo(db);
  lessons.upsertRepo("acme/web", "/w", 1);
  lessons.upsertRepo("acme/api", "/a", 1);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  let t = 100;
  let changed = 0;
  const svc = new ChecksService({
    db, lessons, recorder, now: () => ++t, onChanged: () => changed++,
    config: () => ({ enabled: true, editTimeoutSec: 8, pushTimeoutSec: 600, ticketPattern: "[A-Z]+-\\d+" }),
  });
  const batches = new LessonBatchService({ db, repo: lessons, recorder, now: () => ++t, onChecksChanged: () => changed++ });
  return { db, lessons, recorder, svc, batches, changed: () => changed };
};

const hit = (over: Partial<Extract<CheckLogRecord, { kind: "hit" }>> = {}): Extract<CheckLogRecord, { kind: "hit" }> => ({
  kind: "hit", checkId: 1, checkKey: "builtin:comment_policy", slug: "acme/web", file: "src/a.ts", line: 3, stage: "edit", mode: "enforce", severity: "block",
  outcome: "fail", blocked: true, detail: "x", session: "s1", at: 1000, ...over,
});

describe("ChecksService", () => {
  it("seeds the builtin comment check, off", () => {
    const { svc } = setup();
    const rows = svc.repo.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "builtin:comment_policy", type: "comment_policy", enabled: false, scope: { kind: "global" } });
    expect(svc.anyEnabled()).toBe(false);
    expect(svc.effective({ kind: "global" })).toEqual([]);
  });

  it("creates, edits and deletes checks as undoable batches", () => {
    const { svc, batches, changed } = setup();
    const r = svc.save({ kind: "repo", slug: "acme/web" }, null, fp("foo"));
    expect(r.ok).toBe(true);
    const id = (r as { id: number }).id;
    expect(svc.repo.get(id)?.key).toMatch(/^ck_[0-9a-f]{12}$/);
    expect(svc.repo.get(id)?.batchId).toBe((r as { batchId: number }).batchId);
    expect(changed()).toBe(1);
    const e = svc.save({ kind: "repo", slug: "acme/web" }, id, fp("bar"));
    expect(e.ok).toBe(true);
    expect(svc.repo.get(id)?.params).toEqual({ pattern: "bar" });
    // 换了层的 id 不能借这一层改。
    expect(svc.save({ kind: "global" }, id, fp("baz"))).toEqual({ ok: false, reason: "not_found" });
    batches.undo((e as { batchId: number }).batchId);
    expect(svc.repo.get(id)?.params).toEqual({ pattern: "foo" });
    const d = svc.bulk([id], "delete");
    expect(svc.repo.get(id)).toBeNull();
    batches.undo((d as { batchId: number }).batchId);
    expect(svc.repo.get(id)?.params).toEqual({ pattern: "foo" });
  });

  it("rejects invalid input", () => {
    const { svc } = setup();
    expect(svc.save({ kind: "global" }, null, fp("("))).toMatchObject({ ok: false, reason: "invalid", message: "pattern_invalid" });
    expect(svc.save({ kind: "product", productId: 99 }, null, fp("x"))).toEqual({ ok: false, reason: "not_found" });
  });

  it("resolves global → product → repo, a narrower row with the same key overrides", () => {
    const { svc, lessons } = setup();
    const shop = lessons.createProduct("shop", ["acme/web"], 1);
    const g = (svc.save({ kind: "global" }, null, fp("g")) as { id: number }).id;
    const key = svc.repo.get(g)!.key;
    expect(svc.effective({ kind: "repo", slug: "acme/web" }).map((c) => c.params.pattern)).toEqual(["g"]);
    const o = svc.override({ kind: "product", productId: shop }, key, { mode: "shadow" });
    expect(o.ok).toBe(true);
    expect(svc.effective({ kind: "repo", slug: "acme/web" })).toMatchObject([{ key, mode: "shadow" }]);
    expect(svc.effective({ kind: "repo", slug: "acme/api" })).toMatchObject([{ key, mode: "enforce" }]);
    // 仓库层把它关掉：这个仓库里就没有了。
    expect(svc.override({ kind: "repo", slug: "acme/web" }, key, { enabled: false }).ok).toBe(true);
    expect(svc.effective({ kind: "repo", slug: "acme/web" })).toEqual([]);
    expect(svc.override({ kind: "repo", slug: "acme/web" }, key)).toEqual({ ok: false, reason: "exists" });
    expect(svc.override({ kind: "global" }, key)).toEqual({ ok: false, reason: "bad_scope" });
    const v = svc.view({ kind: "repo", slug: "acme/web" });
    const row = v.checks.find((c) => c.key === key)!;
    expect(row.origin).toEqual({ kind: "repo", slug: "acme/web" });
    expect(row.own?.enabled).toBe(false);
  });

  it("localises the default name and message", () => {
    const { svc } = setup();
    svc.save({ kind: "global" }, null, fp("x", { name: "" }));
    const [c] = svc.effective({ kind: "global" });
    expect(c.name).toBeTruthy();
    expect(c.message).toBeTruthy();
  });

  it("builds a snapshot per known slug", () => {
    const { svc, lessons } = setup();
    svc.save({ kind: "repo", slug: "other/repo" }, null, fp("r"));
    svc.save({ kind: "global" }, null, fp("g"));
    lessons.upsertRepo("acme/third", "/t", 1);
    lessons.createProduct("p", ["acme/third"], 1);
    const s = svc.snapshot();
    expect(s.v).toBe(CHECKS_SNAPSHOT_VERSION);
    expect(s).toMatchObject({ enabled: true, editTimeoutMs: 8000, pushTimeoutMs: 600000, ticketPattern: "[A-Z]+-\\d+" });
    expect(Object.keys(s.repos).sort()).toEqual(["acme/api", "acme/third", "acme/web", "other/repo"]);
    expect(s.repos["other/repo"].map((c) => c.params.pattern)).toEqual(["r", "g"].sort().reverse());
    expect(s.global.map((c) => c.params.pattern)).toEqual(["g"]);
    expect(s.strings.failHeader).toContain("{name}");
  });

  it("bulk changes skip rows already in the target state", () => {
    const { svc } = setup();
    const a = (svc.save({ kind: "global" }, null, fp("a")) as { id: number }).id;
    const b = (svc.save({ kind: "global" }, null, fp("b", { mode: "shadow" })) as { id: number }).id;
    const r = svc.bulk([a, b], "shadow");
    expect(r).toMatchObject({ ok: true, affected: 1 });
    expect(svc.repo.get(a)?.mode).toBe("shadow");
    svc.bulk([a, b], "warn");
    expect(svc.repo.get(b)?.severity).toBe("warn");
    svc.bulk([a], "disable");
    expect(svc.repo.get(a)?.enabled).toBe(false);
  });

  it("saving a check from a lesson marks the lesson converted in the same batch", () => {
    const { svc, lessons, batches } = setup();
    const lid = lessons.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: "no foo", why: "w", at: 1, source: { prNumber: 1, url: null, slug: "acme/web", runId: null } });
    const r = svc.save({ kind: "repo", slug: "acme/web" }, null, fp("foo", { mode: "shadow" }), { lessonId: lid }) as { ok: true; id: number; batchId: number };
    expect(lessons.get(lid)?.checkability).toBe("converted");
    expect(svc.repo.get(r.id)?.lessonId).toBe(lid);
    batches.undo(r.batchId);
    expect(lessons.get(lid)?.checkability).toBeNull();
    expect(svc.repo.get(r.id)).toBeNull();
  });

  it("classifies lessons by hand, undoable", () => {
    const { svc, lessons, batches } = setup();
    const lid = lessons.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: "t", why: "w", at: 1, source: { prNumber: 1, url: null, slug: "acme/web", runId: null } });
    const r = svc.classifyLesson(lid, "prose") as { batchId: number };
    expect(lessons.get(lid)?.checkability).toBe("prose");
    expect(svc.classifyLesson(lid, "prose")).toMatchObject({ ok: true, affected: 0 });
    batches.undo(r.batchId);
    expect(lessons.get(lid)?.checkability).toBeNull();
  });

  it("deleting a product takes its checks along and undo brings them back", () => {
    const { svc, lessons, batches, changed } = setup();
    const p = lessons.createProduct("p", ["acme/web"], 1);
    const id = (svc.save({ kind: "product", productId: p }, null, fp("x")) as { id: number }).id;
    const before = changed();
    const r = batches.deleteProduct(p) as { batchId: number };
    expect(svc.repo.get(id)).toBeNull();
    expect(changed()).toBeGreaterThan(before);
    batches.undo(r.batchId);
    expect(svc.repo.get(id)?.scope).toEqual({ kind: "product", productId: p });
  });

  it("ingests hits once and reports raw stats", () => {
    const { svc } = setup();
    expect(svc.repo.insertHits([{ key: "f:0", rec: hit() }, { key: "f:1", rec: hit({ outcome: "resolved", blocked: false, session: "s2" }) }])).toBe(2);
    expect(svc.repo.insertHits([{ key: "f:0", rec: hit() }])).toBe(0);
    svc.repo.insertHits([{ key: "f:2", rec: hit({ outcome: "unavailable", blocked: false, detail: "sh: not found", at: 2000 }) }]);
    svc.repo.insertHits([{ key: "f:3", rec: hit({ checkId: 999, checkKey: "gone" }) }]);
    const s = svc.repo.stats().get("builtin:comment_policy")!;
    expect(s).toMatchObject({ fails: 1, blocked: 1, resolved: 1, unavailable: 1, sessions: 2, lastHitAt: 2000, lastUnavailable: { at: 2000, detail: "sh: not found" } });
    const [h] = svc.hits("builtin:comment_policy").filter((x) => x.outcome === "fail");
    expect(svc.setVerdict(h.id, "false_positive").ok).toBe(true);
    expect(svc.repo.stats().get("builtin:comment_policy")?.falsePositives).toBe(1);
    expect(svc.hits("gone")[0].checkId).toBeNull();
    expect(svc.hitsForSessions(["s2"])).toHaveLength(1);
    expect(svc.prune(0)).toBe(0);
  });

  it("reports per-session coverage for pre-review", () => {
    const { svc, db } = setup();
    const sessions = new SessionsRepo(db);
    sessions.insertIfAbsent({ id: "s1", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1 });
    sessions.insertIfAbsent({ id: "s2", ticketKey: null, cwd: "/w", origin: "butler", createdAt: 1 });
    sessions.setChecksAbsent("s1", "hook_outdated");
    expect(svc.sessionCoverage(["s1", "s2", "nope"])).toEqual({ s1: { absent: "hook_outdated" }, s2: { absent: null }, nope: { absent: null } });
    expect(sessions.get("s1")?.checksAbsent).toBe("hook_outdated");
  });
});

describe("ChecksService.act", () => {
  it("dispatches page actions", () => {
    const { svc, lessons } = setup();
    const r = svc.act({ op: "save", scope: { kind: "global" }, id: null, input: fp("x") }) as { ok: true; id: number };
    expect(r.ok).toBe(true);
    expect(svc.act({ op: "bulk", ids: [r.id], verb: "warn" })).toMatchObject({ ok: true, affected: 1 });
    const key = svc.repo.get(r.id)!.key;
    expect(svc.act({ op: "override", scope: { kind: "repo", slug: "acme/web" }, key })).toMatchObject({ ok: true });
    const lid = lessons.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: "t", why: "w", at: 1, source: { prNumber: 1, url: null, slug: "acme/web", runId: null } });
    expect(svc.act({ op: "classify", lessonId: lid, checkability: "checkable" })).toMatchObject({ ok: true, affected: 1 });
    expect(svc.act({ op: "verdict", hitId: 999, verdict: "true_positive" })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("bypass and ignored-block stats (workstream F)", () => {
  const DAY = 24 * 3600_000;
  it("counts blocks nobody fixed within a day, and bypass records by key", () => {
    const { db, svc } = setup();
    svc.repo.insertHits([
      { key: "h:0", rec: hit({ file: "src/a.ts", at: 1000 }) },
      { key: "h:1", rec: hit({ file: "src/a.ts", outcome: "resolved", blocked: false, at: 2000 }) },
      { key: "h:2", rec: hit({ file: "src/b.ts", at: 1000 }) },
      { key: "h:3", rec: hit({ file: "src/c.ts", at: 1000, session: "s2" }) },
      { key: "h:4", rec: hit({ file: "src/c.ts", outcome: "resolved", blocked: false, at: 3000, session: "s3" }) },
      { key: "h:5", rec: hit({ file: "src/d.ts", blocked: false, at: 1000 }) },
    ]);
    expect(svc.repo.stats(5000).get("builtin:comment_policy")).toMatchObject({ ignored: 0, bypassed: 0 });
    // b 没人改；c 是别的 session 改的，不算这个 session 改了。d 没拦，不算。
    expect(svc.repo.stats(1000 + DAY + 1).get("builtin:comment_policy")).toMatchObject({ ignored: 2 });
    const bt = new BacktestRepo(db);
    const by = { kind: "bypass" as const, checkId: 1, checkKey: "builtin:comment_policy", slug: "acme/web", file: "", line: null, how: "no_verify" as const, detail: "git commit --no-verify", session: "s1", at: 4000 };
    expect(bt.insertBypassLogs([{ key: "b:0", rec: by }, { key: "b:1", rec: { ...by, checkId: 999, how: "tamper" } }])).toBe(2);
    expect(bt.insertBypassLogs([{ key: "b:0", rec: by }])).toBe(0);
    expect(svc.repo.stats(5000).get("builtin:comment_policy")?.bypassed).toBe(2);
    expect(bt.bypasses(1, 0)).toEqual({ total: 1, how: { no_verify: 1 } });
  });
});

describe("mode change and undo listeners (workstream F)", () => {
  it("reports real mode changes from bulk and edit, and every undo", () => {
    const { svc, batches } = setup();
    const seen: string[] = [];
    svc.onModeChanged((e) => seen.push(`${e.mode}:${e.ids.join(",")}:${e.origin}`));
    batches.onUndone((o, r) => seen.push(`undo:${o.kind}:${r.map((x) => x.id).join(",")}`));
    const a = svc.save({ kind: "repo", slug: "acme/web" }, null, fp("foo", { mode: "shadow" })) as { ok: true; id: number };
    const b = svc.save({ kind: "repo", slug: "acme/web" }, null, fp("bar", { mode: "enforce" })) as { ok: true; id: number };
    const r = svc.bulk([a.id, b.id], "enforce", { origin: "auto", kind: "check_promote", summary: { n: 1 } });
    svc.save({ kind: "repo", slug: "acme/web" }, b.id, fp("bar", { mode: "shadow" }));
    svc.save({ kind: "repo", slug: "acme/web" }, b.id, fp("bar2", { mode: "shadow" }));
    batches.undo(r.ok ? r.batchId! : 0);
    expect(seen).toEqual([`enforce:${a.id}:auto`, `shadow:${b.id}:manual`, `undo:check_promote:${a.id}`]);
  });
});
