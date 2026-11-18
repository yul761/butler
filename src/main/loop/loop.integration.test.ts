import { describe, expect, it, vi } from "vitest";
import { memDb } from "../test-utils";
import { BranchWatchRepo } from "../db/branch-watch-repo";
import { CiTriageRepo } from "../db/ci-triage-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { CiDelivery, pickRecipient } from "../prwatch/ci-delivery";
import type { RunInfo } from "../tickets/gh-loop";
import { LOOP_POLICY_DEFAULTS } from "../../shared/loop-policy";
import { CiTriage, RERUN_CHECK_MS } from "./ci-triage";

/**
 * 验收（工作流 I）：网络超时自动重跑并通过，session 只收到「CI 通过」；同样的失败两次递进 session。
 * 真的 CiDelivery + CiTriage + 库，gh 和终端是假的。
 */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};
const run = (attempt: number, ok: boolean): RunInfo => ({
  attempt, status: "completed", conclusion: ok ? "success" : "failure",
  jobs: [{ name: "test", status: "completed", conclusion: ok ? "success" : "failure", startedAt: null, completedAt: null, steps: [{ name: "Run tests", conclusion: ok ? "success" : "failure", number: 3 }] }],
});
const NET = "test\tRun tests\t2026-11-18T00:00:00Z FetchError: request to https://registry.example.test/x failed, reason: connect ETIMEDOUT";

function world() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", createdAt: 1 });
  const prs = new TicketPrsRepo(db);
  const { pr } = prs.link({ ticketKey: "T-1", url: "https://github.com/o/r/pull/7", slug: "o/r", repoId, number: 7, headBranch: "b", state: "open", source: "branch", linkedAt: 1 });
  const repo = new CiTriageRepo(db);
  let t = 1000;
  let info = run(1, false);
  const reruns: number[] = [];
  const events: string[] = [];
  const deliver = vi.fn(async () => "sent" as const);
  const box: { ci: CiDelivery | null } = { ci: null };
  const triage = new CiTriage({
    repo, policy: () => ({ ...LOOP_POLICY_DEFAULTS, "ci.enabled": true }),
    external: { attempt: (async (_k: string, _d: unknown, f: () => Promise<unknown>) => ({ ran: true, value: await f(), auditId: 1 })) as never },
    gh: { runInfo: async () => info, failedLog: async () => NET, rerunFailed: async (_c, id) => (reruns.push(id), { ok: true, url: null }) },
    model: async () => null,
    where: () => ({ cwd: "/r", slug: "o/r", ticketKey: "T-1", prId: pr.id, target: pr.url }),
    wake: (item) => void box.ci?.settled(item),
    soon: () => undefined,
    recordEvent: (k) => (events.push(k), true),
    later: () => undefined,
    now: () => t, log: () => undefined,
  });
  const ci = new CiDelivery({
    prs, branches: new BranchWatchRepo(db), currentBranch: () => "b",
    guard: { check: () => ({ ok: true, termId: "t1", headId: "h1" }), recheckAfter: () => () => true },
    recipient: (key, rid, branch) => pickRecipient({ owner: "h1", ownerOpen: true, open: [], ticketBranch: "b", branch }),
    deliver, triage, now: () => t, log: () => undefined,
  });
  box.ci = ci;
  /** PrWatcher 读到一个结论。 */
  const read = async (state: "failing" | "passing" | "pending") => {
    prs.update(pr.id, { headSha: "abc1234", ci: state, failed: state === "failing" ? [{ name: "test", state: "failing", runId: 55, log: NET }] : [], checkedAt: t });
    if (state !== "pending") await ci.settled({ kind: "pr", id: pr.id });
    await settle();
  };
  return { read, deliver, reruns, events, repo, advance: (ms: number) => void (t += ms), setInfo: (i: RunInfo) => void (info = i) };
}

describe("comment and CI loop acceptance", () => {
  it("reruns a network timeout and only tells the session that CI passed", async () => {
    const w = world();
    await w.read("failing");
    expect(w.reruns).toEqual([55]);
    expect(w.deliver).not.toHaveBeenCalled();
    await w.read("pending");
    w.setInfo(run(2, true));
    w.advance(RERUN_CHECK_MS);
    await w.read("passing");
    expect(w.deliver).toHaveBeenCalledTimes(1);
    expect((w.deliver.mock.calls[0] as unknown as [string, string])[1]).toMatch(/CI 全部通过|CI passed/);
    expect(w.events).toEqual(["ci_rerun", "ci_flaky"]);
    expect(w.repo.flakyEntries(0)).toMatchObject([{ kind: "check", name: "test", count: 1 }]);
  });

  it("delivers the same failure twice to the session", async () => {
    const w = world();
    await w.read("failing");
    expect(w.reruns).toEqual([55]);
    await w.read("pending");
    w.setInfo(run(2, false));
    w.advance(RERUN_CHECK_MS);
    await w.read("failing");
    // 重跑结果由 triage 自己查到（attempt 变了），再分类、叫醒 CiDelivery。
    await settle();
    expect(w.deliver).toHaveBeenCalledTimes(1);
    const text = (w.deliver.mock.calls[0] as unknown as [string, string])[1];
    expect(text).toMatch(/CI 失败|CI failed/);
    expect(text).toMatch(/同样的失败|failed the same way/);
    expect(w.reruns).toEqual([55]);
  });
});
