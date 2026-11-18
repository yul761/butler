import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { migrate } from "../db/database";
import { CiTriageRepo } from "../db/ci-triage-repo";
import type { CiCheck } from "../tickets/gh";
import type { RunInfo } from "../tickets/gh-loop";
import { LOOP_POLICY_DEFAULTS, type LoopPolicy } from "../../shared/loop-policy";
import { CiTriage, PASSED_GRACE_MS, RERUN_CHECK_MS, type CiTriageDeps } from "./ci-triage";

const ITEM = { kind: "pr" as const, id: 1 };
const failRun = (attempt: number): RunInfo => ({
  attempt, status: "completed", conclusion: "failure",
  jobs: [{ name: "test", status: "completed", conclusion: "failure", startedAt: null, completedAt: null, steps: [{ name: "Run tests", conclusion: "failure", number: 3 }] }],
});
const okRun = (attempt: number): RunInfo => ({ attempt, status: "completed", conclusion: "success", jobs: [] });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

function setup(over: Partial<LoopPolicy> = {}, o: { allowed?: boolean; rerunOk?: boolean; log?: string; model?: { category: "env" | "code"; reason: string } | null } = {}) {
  const db = memDb();
  migrate(db);
  const repo = new CiTriageRepo(db);
  let t = 1000;
  let info: RunInfo = failRun(1);
  let log = o.log ?? "test\tRun tests\t2026-11-18T00:00:00Z Error: connect ETIMEDOUT 10.0.0.1:443";
  const calls = { reruns: 0, audits: [] as string[], wakes: 0, soons: 0, events: [] as { kind: string; dedupeKey?: string }[], model: 0, timers: [] as (() => void)[] };
  const policy = { ...LOOP_POLICY_DEFAULTS, "ci.enabled": true, ...over };
  const d: CiTriageDeps = {
    repo,
    policy: () => policy,
    external: {
      attempt: (async (_kind: string, _detail: unknown, run: () => Promise<unknown>) => {
        if (o.allowed === false) return calls.audits.push("skipped"), { ran: false, auditId: 1 };
        try {
          const value = await run();
          calls.audits.push("done");
          return { ran: true, value, auditId: 1 };
        } catch (e) {
          calls.audits.push("failed");
          throw e;
        }
      }) as CiTriageDeps["external"]["attempt"],
    },
    gh: {
      runInfo: async () => info,
      failedLog: async () => log,
      rerunFailed: async () => (calls.reruns++, o.rerunOk === false ? { ok: false, error: "nope" } : { ok: true, url: null }),
    },
    model: async () => (calls.model++, o.model ?? null),
    where: () => ({ cwd: "/r", slug: "o/r", ticketKey: "T-1", prId: 1, target: "https://example.test/pr/1" }),
    wake: () => void calls.wakes++,
    soon: () => void calls.soons++,
    recordEvent: (kind, refs) => (calls.events.push({ kind, dedupeKey: refs?.dedupeKey }), true),
    later: (_ms, f) => void calls.timers.push(f),
    now: () => t,
    log: () => undefined,
  };
  const triage = new CiTriage(d);
  const failing = (runId: number | null = 7, name = "test"): { headSha: string; ci: string; failed: CiCheck[] } => ({ headSha: "abc", ci: "failing", failed: [{ name, state: "failing", runId, log }] });
  return {
    triage, repo, calls, failing,
    advance: (ms: number) => void (t += ms),
    setInfo: (i: RunInfo) => void (info = i),
    setLog: (l: string) => void (log = l),
    decide: (row = failing()) => triage.decide(ITEM, row),
  };
}

describe("CiTriage", () => {
  it("delivers as is when the policy is off, and does not record anything", () => {
    const s = setup({ "ci.enabled": false });
    expect(s.decide()).toEqual({ action: "deliver", note: null });
    expect(s.repo.atSha({ kind: "pr", id: 1 }, "abc")).toHaveLength(0);
  });

  it("delivers external checks (no run id) straight away", () => {
    const s = setup();
    expect(s.decide(s.failing(null)).action).toBe("deliver");
    expect(s.calls.reruns).toBe(0);
  });

  it("reruns a network failure, holds while it runs, and records flakiness when it passes", async () => {
    const s = setup();
    expect(s.decide()).toEqual({ action: "hold", reason: "triage" });
    await settle();
    expect(s.repo.atSha(ITEM, "abc")[0]).toMatchObject({ state: "classified", category: "env", source: "rule" });
    expect(s.calls.wakes).toBe(1);
    expect(s.decide().action).toBe("hold");
    await settle();
    expect(s.calls.reruns).toBe(1);
    expect(s.calls.audits).toEqual(["done"]);
    expect(s.calls.soons).toBe(1);
    expect(s.calls.events.map((e) => e.kind)).toEqual(["ci_rerun"]);
    expect(s.repo.atSha(ITEM, "abc")[0]).toMatchObject({ state: "rerunning", reruns: 1, rerunAttempt: 1 });
    // 还没到下一次查的时间：不问 gh，排一个定时器。
    expect(s.decide().action).toBe("hold");
    expect(s.calls.timers).toHaveLength(1);
    s.setInfo(okRun(2));
    s.advance(RERUN_CHECK_MS);
    expect(s.decide().action).toBe("hold");
    await settle();
    const row = s.repo.atSha(ITEM, "abc")[0];
    expect(row).toMatchObject({ state: "passed", outcome: "passed" });
    expect(s.calls.events.map((e) => e.kind)).toEqual(["ci_rerun", "ci_flaky"]);
    expect(s.repo.flakyCount("o/r", "check", "test", 0)).toBe(1);
    // PrWatcher 还拿着旧的失败：先不递；通过的结论照常递。
    expect(s.decide().action).toBe("hold");
    expect(s.decide({ headSha: "abc", ci: "passing", failed: [] })).toEqual({ action: "deliver", note: null });
    s.advance(PASSED_GRACE_MS);
    expect(s.decide().action).toBe("deliver");
  });

  it("delivers the same failure twice as code with a note", async () => {
    const s = setup();
    s.decide();
    await settle();
    s.decide();
    await settle();
    s.setInfo(failRun(2));
    s.advance(RERUN_CHECK_MS);
    s.decide();
    await settle();
    const d = s.decide();
    expect(d.action).toBe("deliver");
    expect(d.action === "deliver" && d.note).toMatch(/同样的失败/);
    if (d.action === "deliver") d.onSent?.();
    expect(s.repo.atSha(ITEM, "abc")[0]).toMatchObject({ state: "delivered", outcome: "same_twice" });
  });

  it("stops at the rerun cap and says it may be flaky", async () => {
    const s = setup({ "ci.maxReruns": 1 });
    s.decide();
    await settle();
    s.decide();
    await settle();
    // 第二次失败的日志不一样：不是「同样的失败」，但已经到上限了。
    s.setLog("test\tRun tests\t2026-11-18T00:00:00Z Error: socket hang up");
    s.setInfo(failRun(2));
    s.advance(RERUN_CHECK_MS);
    s.decide();
    await settle();
    const d = s.decide();
    expect(d.action === "deliver" && d.note).toMatch(/可能是 flaky/);
  });

  it("delivers with a note when reruns are switched off or fail", async () => {
    const off = setup({}, { allowed: false });
    off.decide();
    await settle();
    off.decide();
    await settle();
    expect(off.calls.audits).toEqual(["skipped"]);
    const d = off.decide();
    expect(d.action === "deliver" && d.note).toMatch(/自动重跑没开/);

    const bad = setup({}, { rerunOk: false });
    bad.decide();
    await settle();
    bad.decide();
    await settle();
    expect(bad.calls.audits).toEqual(["failed"]);
    const e = bad.decide();
    expect(e.action === "deliver" && e.note).toMatch(/触发重跑失败/);
  });

  it("delivers code failures without a note, asking the model only when no rule matches", async () => {
    const s = setup({}, { log: "test\tRun tests\t2026-11-18T00:00:00Z something odd happened", model: { category: "code", reason: "logic" } });
    expect(s.decide().action).toBe("hold");
    await settle();
    expect(s.calls.model).toBe(1);
    expect(s.decide()).toMatchObject({ action: "deliver", note: null });
    const t = setup({ "ci.useModel": false }, { log: "test\tRun tests\t2026-11-18T00:00:00Z something odd happened" });
    t.decide();
    await settle();
    expect(t.calls.model).toBe(0);
    expect(t.repo.atSha(ITEM, "abc")[0]).toMatchObject({ category: "code", source: "fallback", reason: "no_rule" });
  });

  it("lists a check automatically after enough flaky passes", async () => {
    const s = setup({ "ci.autoListThreshold": 1 });
    s.decide();
    await settle();
    s.decide();
    await settle();
    s.decide({ headSha: "abc", ci: "passing", failed: [] });
    expect(s.repo.listed("o/r")).toEqual(["test"]);
    // 列入名单以后：新 sha 上同一个检查直接按 flaky 处理、重跑。
    s.triage.decide(ITEM, { headSha: "def", ci: "failing", failed: [{ name: "test", state: "failing", runId: 8, log: "test\tRun tests\t2026-11-18T00:00:00Z expected 1 to be 2" }] });
    await settle();
    expect(s.repo.atSha(ITEM, "def")[0]).toMatchObject({ category: "flaky", source: "list" });
    expect(s.repo.atSha(ITEM, "abc")[0].state).toBe("passed");
  });
});
