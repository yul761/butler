import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationLevel } from "../../shared/automation";
import type { PreReviewVerdict, ReviewTarget } from "../../shared/prereview";
import type { Session, Ticket, TicketRepo } from "../../shared/types";
import { presetWorkflow, type Workflow } from "../../shared/workflow";
import type { StageEvent } from "../db/pr-stage-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import { WorkflowRepo } from "../db/workflow-repo";
import { setLang } from "../i18n";
import { memDb } from "../test-utils";
import type { BotReviewResult } from "./bot-review";
import { NO_CI_GRACE_MS, splitBotRounds, WorkflowService } from "./workflow-service";

afterEach(() => setLang("zh"));

const repoRow = (id: number, key: string, path: string, branch: string): TicketRepo => ({
  id, ticketKey: key, repoPath: path, workMode: "worktree", worktreePath: `${path}-wt`, branch, createdAt: 1, worktreeRemovedAt: null, cleanupBlocked: null,
});

const ticket = (key: string, repos: TicketRepo[], featureId: number | null = 4): Ticket => ({
  key, title: null, repos, status: "in_progress" as Ticket["status"], statusManual: null, createdAt: 1, archivedAt: null, featureId,
});

const pr = (o: Partial<TicketPr> & { id: number; ticketKey: string; repoId: number | null }): TicketPr =>
  ({
    url: `https://github.com/o/a/pull/${o.id}`, slug: "o/a", number: o.id, headBranch: "feature/X-1", state: "open", review: null, ci: "pending", readError: false,
    headSha: "s1", failed: [], openedAt: 1, mergedAt: null, closedAt: null, source: "branch", linkedAt: 1, checkedAt: 1, ...o,
  }) as TicketPr;

const session = (o: Partial<Session> & { id: string }): Session => ({ ticketKey: null, coordinator: false, featureId: null, fixesSession: null, shipherd: false, repoId: null, gitBranch: null, ...o }) as Session;

function setup(o: { tickets?: Ticket[]; level?: AutomationLevel } = {}) {
  const db = memDb();
  const repo = new WorkflowRepo(db);
  let now = 1_000_000;
  const tickets = o.tickets ?? [ticket("X-1", [repoRow(1, "X-1", "/r/a", "feature/X-1")])];
  const prs: TicketPr[] = [];
  const events: StageEvent[] = [];
  const preReviews: { target: ReviewTarget; verdict: PreReviewVerdict; id: number }[] = [];
  const sent: { to: string; body: string; ref: string }[] = [];
  const queued = new Map<string, { to: string; body: string }>();
  const heads = new Map<string, string>();
  const sessions = new Map<string, Session>();
  const bot: { calls: number; result: BotReviewResult; gate?: Promise<void> } = { calls: 0, result: { ok: true, via: "api" } };
  const counts: { calls: string[][]; result: number | null } = { calls: [], result: 0 };
  let recipient: string | null = "sess-1";
  let level: AutomationLevel = o.level ?? "semi";
  const mk = () =>
    new WorkflowService({
      repo,
      tickets: { get: (k) => tickets.find((t) => t.key === k) ?? null, list: () => tickets },
      featureName: (id) => (id === 4 ? "4.3.0" : null),
      productsOf: (slug) => (slug === "o/a" ? [{ id: 9, name: "Shipherd" }] : []),
      productName: (id) => (id === 9 ? "Shipherd" : null),
      slugOf: (p) => (p === "/r/a" ? "o/a" : p === "/r/b" ? "o/b" : null),
      prs: { byTicket: (k) => prs.filter((p) => p.ticketKey === k) },
      stages: { forTicket: (k) => events.filter((e) => e.ticketKey === k) },
      preReviews: {
        latestFor: (t) => [...preReviews].reverse().find((p) => p.target.repoSlug === t.repoSlug && p.target.branch === t.branch && p.target.headSha === t.headSha) ?? null,
        latestForBranch: (slug, branch) => [...preReviews].reverse().find((p) => p.target.repoSlug === slug && p.target.branch === branch) ?? null,
      },
      headSha: async (dir, branch) => heads.get(`${dir}|${branch}`) ?? null,
      level: () => level,
      mailbox: {
        send: (m) => {
          sent.push({ to: m.to, body: m.body, ref: m.ref });
          queued.set(m.ref, { to: m.to, body: m.body });
        },
        withdraw: (ref) => void queued.delete(ref),
      },
      recipient: () => recipient,
      coordinator: (f) => (f === 4 ? "coord-4" : null),
      session: (id) => sessions.get(id) ?? null,
      requestBotReview: async () => {
        bot.calls++;
        if (bot.gate) await bot.gate;
        return bot.result;
      },
      reviewCommentCount: async (_pr, _cwd, ids) => {
        counts.calls.push(ids);
        return counts.result;
      },
      ghCwd: () => "/r/a-wt",
      now: () => now,
      log: () => {},
      onChange: () => {},
    });
  return {
    db, repo, tickets, prs, events, preReviews, sent, queued, heads, sessions, bot, counts, mk,
    svc: mk(),
    tick: (ms: number) => (now += ms),
    now: () => now,
    setRecipient: (r: string | null) => (recipient = r),
    setLevel: (l: AutomationLevel) => (level = l),
  };
}

const ev = (o: Partial<StageEvent> & { kind: StageEvent["kind"]; at: number; data: Record<string, unknown> }): StageEvent => ({
  id: Math.random(), ticketKey: "X-1", repoId: 1, prId: 1, branch: "feature/X-1", featureId: null, sessionId: null, ...o,
});

describe("WorkflowService: layers", () => {
  it("the hot-path lookup doesn't read tickets or layers when no workflow is set (BTL-273 review 10)", () => {
    const t = setup();
    const layers = vi.spyOn(t.repo, "layers");
    const get = vi.spyOn(t.tickets, "find");
    expect(t.svc.workflowFor("X-1")).toBeNull();
    expect(t.svc.workflowFor(null)).toBeNull();
    expect(layers).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    t.svc.setLayer({ kind: "global" }, { steps: ["implement", "open_pr"] });
    expect(t.repo.hasLayers()).toBe(true);
    expect(t.svc.workflowFor("X-1")?.steps.map((x) => (typeof x === "string" ? x : x.id))).toEqual(["implement", "open_pr"]);
    // 一层读坏了：当成没有，按原来的开关走
    t.db.prepare(`UPDATE workflow_layers SET workflow = 'not json'`).run();
    expect(t.repo.hasLayers()).toBe(true);
    expect(t.svc.workflowFor("X-1")).toBeNull();
  });

  it("no layer means no workflow and nothing changes", async () => {
    const t = setup();
    expect(t.svc.effective("X-1")).toBeNull();
    expect(t.svc.anyWorkflow()).toBe(false);
    await t.svc.evaluate("X-1");
    expect(t.sent).toEqual([]);
    expect(await t.svc.prCreate({ ticketKey: "X-1", repoPath: "/r/a", dir: "/r/a-wt", branch: "feature/X-1", draft: false })).toBeNull();
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "sess-1" })).toBeNull();
  });

  it("the deepest layer wins: global → product → repo → epic → ticket", () => {
    const t = setup();
    const at = (w: Workflow) => ({ steps: w.steps, notes: "" });
    t.svc.setLayer({ kind: "global" }, at(presetWorkflow("strict")));
    expect(t.svc.effective("X-1")?.scope).toEqual({ kind: "global" });
    t.svc.setLayer({ kind: "product", productId: 9 }, presetWorkflow("fast"));
    expect(t.svc.effective("X-1")).toMatchObject({ scope: { kind: "product", productId: 9 }, label: "Shipherd" });
    t.svc.setLayer({ kind: "repo", slug: "O/A" }, presetWorkflow("strict"));
    expect(t.svc.effective("X-1")?.scope).toEqual({ kind: "repo", slug: "o/a" });
    t.svc.setLayer({ kind: "feature", featureId: 4 }, presetWorkflow("fast"));
    expect(t.svc.effective("X-1")).toMatchObject({ scope: { kind: "feature", featureId: 4 }, label: "4.3.0" });
    t.svc.setLayer({ kind: "ticket", ticketKey: "X-1" }, { steps: ["implement", "open_pr"] });
    expect(t.svc.effective("X-1")?.workflow.steps.map((s) => s.id)).toEqual(["implement", "open_pr"]);
    expect(t.svc.chain("X-1").map((l) => l.scope.kind)).toEqual(["global", "product", "repo", "feature", "ticket"]);
    t.svc.setLayer({ kind: "ticket", ticketKey: "X-1" }, null);
    expect(t.svc.effective("X-1")?.scope.kind).toBe("feature");
  });

  it("a repo layer applies only to tickets in that repo", () => {
    const t = setup({ tickets: [ticket("X-1", [repoRow(1, "X-1", "/r/a", "feature/X-1")]), ticket("Y-1", [repoRow(2, "Y-1", "/r/b", "feature/X-1")])] });
    t.svc.setLayer({ kind: "repo", slug: "o/b" }, presetWorkflow("fast"));
    expect(t.svc.effective("X-1")).toBeNull();
    expect(t.svc.effective("Y-1")?.scope).toEqual({ kind: "repo", slug: "o/b" });
  });

  it("rejects a bad workflow with a readable reason", () => {
    const t = setup();
    expect(t.svc.setLayer({ kind: "global" }, { steps: ["ci_green"] })).toMatchObject({ ok: false, message: "「CI 通过」要排在「开 PR」后面（流程里也要有开 PR 这一步）" });
    setLang("en");
    expect(t.svc.setLayer({ kind: "global" }, { steps: ["deploy"] })).toMatchObject({ ok: false, message: expect.stringMatching(/^Unknown step: deploy/) });
  });
});

describe("WorkflowService: progress and notices", () => {
  it("records steps from the facts and tells the session the next step once, even after a restart", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "feature", featureId: 4 }, presetWorkflow("fast"));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("implement");
    expect(t.sent.map((s) => s.ref)).toEqual(["workflow:X-1"]);
    expect(t.sent[0].body).toContain("第 1/4 步「写代码」");
    // 同样的状态再判断：不重送；重启（新实例、同一个库）也不重送
    await t.svc.evaluate("X-1");
    await t.mk().evaluateAll();
    expect(t.sent).toHaveLength(1);

    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    const v = t.svc.view("X-1");
    expect(v.steps.map((s) => s.state)).toEqual(["done", "done", "current", "todo"]);
    expect(t.sent.at(-1)!.body).toContain("CI 通过");
  });

  it("withdraws the queued notice when the step moves on, even if no session can take the new one", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "feature", featureId: 4 }, presetWorkflow("fast"));
    await t.svc.evaluate("X-1");
    expect(t.queued.has("workflow:X-1")).toBe(true);
    t.setRecipient(null);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    expect(t.queued.has("workflow:X-1")).toBe(false);
    // session 回来以后补送
    t.setRecipient("sess-1");
    await t.svc.evaluate("X-1");
    expect(t.queued.get("workflow:X-1")?.body).toContain("CI 通过");
  });

  it("a PR in another repo on the same branch name is not this ticket's", async () => {
    const t = setup({ tickets: [ticket("X-1", [repoRow(1, "X-1", "/r/a", "feature/X-1")]), ticket("Y-1", [repoRow(2, "Y-1", "/r/b", "feature/X-1")])] });
    t.svc.setLayer({ kind: "global" }, presetWorkflow("fast"));
    // Y-1 的仓库里同名分支开了 PR：挂在 X-1 名下的那条 repoId 是 null（slug 对不上），不算
    t.prs.push(pr({ id: 5, ticketKey: "X-1", repoId: null, slug: "o/b", ci: "passing" }));
    t.prs.push(pr({ id: 6, ticketKey: "Y-1", repoId: 2, slug: "o/b", ci: "passing" }));
    await t.svc.evaluate("X-1");
    await t.svc.evaluate("Y-1");
    expect(t.svc.view("X-1").current).toBe("implement");
    expect(t.svc.view("Y-1").current).toBe("merge");
  });

  it("ci none counts only after the grace period", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, presetWorkflow("fast"));
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1, ci: "none", openedAt: t.now() }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("ci_green");
    t.tick(NO_CI_GRACE_MS);
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("merge");
  });

  it("CI passing is only what it is now: a red run after a push moves the ticket back", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, presetWorkflow("fast"));
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1, ci: "passing" }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("merge");
    t.prs[0].ci = "failing";
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("ci_green");
    expect(t.repo.done("X-1").map((d) => d.step)).not.toContain("ci_green");
  });

  it("tells the epic coordinator when a coordinator-merged ticket reaches the merge", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, presetWorkflow("fast"));
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1, ci: "passing" }));
    await t.svc.evaluate("X-1");
    const c = t.sent.filter((s) => s.to === "coord-4");
    expect(c).toHaveLength(1);
    expect(c[0].body).toContain("https://github.com/o/a/pull/1");
    expect(t.queued.get("workflow:X-1")?.body).toContain("等总控来合");
    // 合并以后流程走完：两条提醒都撤掉
    t.prs[0].state = "merged";
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBeNull();
    expect(t.queued.size).toBe(0);
  });

  it("only session steps can be marked by the session", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, presetWorkflow("strict"));
    expect(t.svc.markStep("X-1", "pre_review", null)).toMatchObject({ ok: false });
    expect(t.svc.markStep("X-1", "human_review", null)).toMatchObject({ ok: false, message: expect.stringContaining("没有") });
    expect(t.svc.markStep("X-1", "implement", "done")).toMatchObject({ ok: true, message: "记下了：「写代码」做完了。下一步是「自审」。" });
  });

  it("a review skill completes the self-review", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, presetWorkflow("strict"));
    t.svc.markStep("X-1", "implement", null);
    t.events.push(ev({ kind: "skill", at: 5, prId: null, data: { name: "code-review", category: "review" } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("pre_review");
  });
});

describe("WorkflowService: gate", () => {
  const strictUpToPr = { steps: ["implement", "self_review", "pre_review", { id: "open_pr", draft: true }, "ci_green", "merge"] };

  it("blocks gh pr create until the steps before it are done and the commit passed pre-review", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, strictUpToPr);
    const req = { ticketKey: "X-1", repoPath: "/r/a", dir: "/r/a-wt", branch: "feature/X-1", draft: true };
    expect(await t.svc.prCreate(req)).toContain("「自审」");
    t.svc.markStep("X-1", "self_review", null);
    t.heads.set("/r/a-wt|feature/X-1", "s2");
    expect(await t.svc.prCreate(req)).toContain("还没通过预审");
    // 旧提交的预审 clean 不算
    t.preReviews.push({ id: 1, target: { repoSlug: "o/a", branch: "feature/X-1", headSha: "s1" }, verdict: "clean" });
    expect(await t.svc.prCreate(req)).toContain("还没通过预审");
    t.preReviews.push({ id: 2, target: { repoSlug: "o/a", branch: "feature/X-1", headSha: "s2" }, verdict: "violations" });
    expect(await t.svc.prCreate(req)).toContain("还没通过预审");
    t.preReviews.push({ id: 3, target: { repoSlug: "o/a", branch: "feature/X-1", headSha: "s2" }, verdict: "clean" });
    expect(await t.svc.prCreate({ ...req, draft: false })).toContain("--draft");
    expect(await t.svc.prCreate(req)).toBeNull();
    // 闸门给的仓库路径写法不同（末尾斜杠、Windows 大小写）也认得出是这个仓库
    expect(await t.svc.prCreate({ ...req, repoPath: "/r/a/" })).toBeNull();
  });

  it("a repo it can't tell apart: every repo of the ticket on that branch must be clean, not the first one", async () => {
    // 同一 ticket 两个仓库用同名分支，只有 A 的预审 clean；从 B 开 PR、目录又认不出（cd "$WT" && gh pr create --head …）时要拦下
    const b = "feature/X-1";
    const t = setup({ tickets: [ticket("X-1", [repoRow(1, "X-1", "/r/a", b), repoRow(2, "X-1", "/r/b", b)])] });
    t.svc.setLayer({ kind: "global" }, { steps: ["implement", "pre_review", "open_pr", "merge"] });
    t.heads.set(`/r/a-wt|${b}`, "a1");
    t.heads.set(`/r/b-wt|${b}`, "b1");
    t.preReviews.push({ id: 1, target: { repoSlug: "o/a", branch: b, headSha: "a1" }, verdict: "clean" });
    const unknown = { ticketKey: "X-1", repoPath: null, dir: null, branch: b, draft: false };
    expect(await t.svc.prCreate(unknown)).toContain("还没通过预审");
    // 认得出是 A：A 的预审放行 A
    expect(await t.svc.prCreate({ ...unknown, repoPath: "/r/a", dir: "/r/a-wt" })).toBeNull();
    // 认得出是 B：A 的预审不能放行 B
    expect(await t.svc.prCreate({ ...unknown, repoPath: "/r/b", dir: "/r/b-wt" })).toContain("还没通过预审");
    // 两个都 clean 了，认不出仓库也放行
    t.preReviews.push({ id: 2, target: { repoSlug: "o/b", branch: b, headSha: "b1" }, verdict: "clean" });
    expect(await t.svc.prCreate(unknown)).toBeNull();
  });

  it("a user-merged workflow blocks every session, the coordinator included", () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, presetWorkflow("strict"));
    t.sessions.set("coord-4", session({ id: "coord-4", featureId: 4 }));
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "coord-4" })).toContain("用户自己合");
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "sess-1" })).toContain("用户自己合");
  });

  it("a workflow without a merge step leaves the merge to the user", () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, { steps: ["implement", "open_pr", "ci_green"] });
    t.sessions.set("coord-4", session({ id: "coord-4", featureId: 4 }));
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "coord-4" })).toContain("用户自己合");
  });

  it("a coordinator-merged workflow lets only a coordinator merge, and only once CI is green now", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, presetWorkflow("fast"));
    t.sessions.set("coord-4", session({ id: "coord-4", featureId: 4 }));
    t.sessions.set("sess-1", session({ id: "sess-1", ticketKey: "X-1", featureId: 4 }));
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1, ci: "passing" }));
    await t.svc.evaluate("X-1");
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "sess-1" })).toContain("由总控来合");
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "coord-4" })).toBeNull();
    // 记下过 CI 绿，但新 push 以后 CI 又在跑：按现在的状态拦
    t.prs[0].ci = "pending";
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "coord-4" })).toContain("「CI 通过」");
  });
});

describe("WorkflowService: review fixes (BTL-273)", () => {
  const coordMerge = { id: "merge", mergeBy: "coordinator" };
  const queuedNotice = (t: ReturnType<typeof setup>) => [...t.queued.entries()].filter(([ref]) => ref.includes("X-1"));

  it("a pre-review after open_pr doesn't hold back the PR: the reminder and the gate agree", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, { steps: ["implement", "open_pr", "pre_review", "merge"] });
    t.svc.markStep("X-1", "implement", null);
    await t.svc.evaluate("X-1");
    const body = t.sent.at(-1)!.body;
    expect(body).toContain("可以开 PR 了");
    expect(body).not.toContain("通过预审");
    t.heads.set("/r/a-wt|feature/X-1", "s1");
    expect(await t.svc.prCreate({ ticketKey: "X-1", repoPath: "/r/a", dir: "/r/a-wt", branch: "feature/X-1", draft: false })).toBeNull();
  });

  it("a pre-review before open_pr: the reminder says the commit must pass, and the gate checks it", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, { steps: ["implement", "pre_review", "open_pr", "merge"] });
    t.svc.markStep("X-1", "implement", null);
    t.preReviews.push({ id: 1, target: { repoSlug: "o/a", branch: "feature/X-1", headSha: "s1" }, verdict: "clean" });
    await t.svc.evaluate("X-1");
    expect(t.sent.at(-1)!.body).toContain("现在这个提交要通过预审");
    // 预审之后又提交了：闸门按这次的提交拦
    t.heads.set("/r/a-wt|feature/X-1", "s2");
    expect(await t.svc.prCreate({ ticketKey: "X-1", repoPath: "/r/a", dir: "/r/a-wt", branch: "feature/X-1", draft: false })).toContain("还没通过预审");
  });

  it("the stack's own PR opening uses the hook's judgment: blocked without a pre-review, draft when the workflow wants one (review 11)", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, { steps: ["implement", "pre_review", { id: "open_pr", draft: true }, "merge"] });
    t.heads.set("/r/a-wt|feature/X-1", "s1");
    const at = { ticketKey: "X-1", repoPath: "/r/a", branch: "feature/X-1" };
    expect(await t.svc.prOpenMode(at)).toEqual({ mode: "blocked", reason: expect.stringContaining("还没通过预审") });
    t.preReviews.push({ id: 1, target: { repoSlug: "o/a", branch: "feature/X-1", headSha: "s1" }, verdict: "clean" });
    expect(await t.svc.prOpenMode(at)).toEqual({ mode: "draft" });
    t.svc.setLayer({ kind: "global" }, { steps: ["implement", "pre_review", "open_pr", "merge"] });
    expect(await t.svc.prOpenMode(at)).toEqual({ mode: "open" });
    // 没有流程：照常开
    t.svc.setLayer({ kind: "global" }, null);
    expect(await t.svc.prOpenMode(at)).toEqual({ mode: "open" });
  });

  it("a finished ticket gets no more reminders: a queued one is withdrawn, and evaluateAll / layer changes skip it", async () => {
    const t = setup({ tickets: [ticket("X-1", [repoRow(1, "X-1", "/r/a", "feature/X-1")]), ticket("X-2", [repoRow(2, "X-2", "/r/a", "feature/X-2")])] });
    t.svc.setLayer({ kind: "global" }, presetWorkflow("fast"));
    await t.svc.evaluate("X-1");
    expect(queuedNotice(t)).toHaveLength(1);
    // 手动标成 done（status 还是进行中）：实际状态按手动的算
    t.tickets[0].statusManual = "done";
    await t.svc.evaluate("X-1");
    expect(queuedNotice(t)).toEqual([]);
    const n = t.sent.length;
    t.svc.setLayer({ kind: "global" }, presetWorkflow("strict"));
    await t.svc.evaluateAll();
    expect(t.sent.slice(n).some((m) => m.body.includes("X-1"))).toBe(false);
    expect(t.sent.slice(n).some((m) => m.body.includes("X-2"))).toBe(true);
    // 归档了也一样
    t.tickets[1].archivedAt = 5;
    await t.svc.evaluate("X-2");
    expect([...t.queued.keys()].filter((r) => r.includes("X-2"))).toEqual([]);
  });

  it("all PRs merged: the workflow counts as finished and the reminder is withdrawn, even mid comment loop", async () => {
    const t = setup();
    const botFlow = { steps: ["implement", "open_pr", { id: "bot_review", bot: "copilot" }, "address_comments", "re_review", { id: "merge", mergeBy: "user" }] };
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    t.events.push(ev({ kind: "review", at: t.now() + 5, data: { id: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    t.events.push(ev({ kind: "comment", at: t.now() + 5, data: { id: 8, reviewId: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("address_comments");
    expect(queuedNotice(t)).toHaveLength(1);
    t.prs[0].state = "merged";
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBeNull();
    expect(queuedNotice(t)).toEqual([]);
    // 不记进库：只有 implement 这类真做过的才在库里
    expect(t.repo.done("X-1").map((d) => d.step)).not.toContain("address_comments");
  });

  it("a workflow with no merge step says in the guide that the user merges", () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, { steps: ["implement", "open_pr", "ci_green"] });
    expect(t.svc.guideLines("X-1").join("\n")).toContain("没有合并这一步：由用户自己合");
    t.svc.setLayer({ kind: "global" }, presetWorkflow("fast"));
    expect(t.svc.guideLines("X-1").join("\n")).not.toContain("没有合并这一步");
  });

  it("only the global coordinator or the ticket's own epic coordinator counts as the coordinator who merges", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, { steps: ["implement", "open_pr", coordMerge] });
    t.svc.markStep("X-1", "implement", null);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    t.sessions.set("coord-5", session({ id: "coord-5", featureId: 5 }));
    t.sessions.set("coord-4", session({ id: "coord-4", featureId: 4 }));
    t.sessions.set("global", session({ id: "global", shipherd: true }));
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "coord-5" })).toContain("由总控来合");
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "coord-4" })).toBeNull();
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "global" })).toBeNull();
  });

  it("a merge checks pre-review at the PR's current head: a new unreviewed push can't merge on the old record", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, { steps: ["implement", "pre_review", "open_pr", "ci_green", coordMerge] });
    t.sessions.set("coord-4", session({ id: "coord-4", featureId: 4 }));
    t.svc.markStep("X-1", "implement", null);
    t.preReviews.push({ id: 1, target: { repoSlug: "o/a", branch: "feature/X-1", headSha: "s1" }, verdict: "clean" });
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1, headSha: "s1", ci: "passing" }));
    await t.svc.evaluate("X-1");
    expect(t.repo.done("X-1").map((d) => d.step)).toContain("pre_review");
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "coord-4" })).toBeNull();
    t.prs[0].headSha = "s2";
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "coord-4" })).toContain("#1 现在的提交还没通过预审");
    t.preReviews.push({ id: 2, target: { repoSlug: "o/a", branch: "feature/X-1", headSha: "s2" }, verdict: "clean" });
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: "coord-4" })).toBeNull();
  });
});

describe("WorkflowService: bot review", () => {
  const botFlow = { steps: ["implement", "open_pr", { id: "bot_review", bot: "copilot" }, "address_comments", { id: "re_review", maxRounds: 1 }, { id: "merge", mergeBy: "user" }] };

  it("asks once even when two evaluations race, and waits for the bot", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    let release!: () => void;
    t.bot.gate = new Promise<void>((r) => (release = r));
    const a = t.svc.evaluate("X-1");
    // 另一个实例（另一个入口）同时判断：行已经占了，不再请
    const b = t.mk().evaluate("X-1");
    release();
    await Promise.all([a, b]);
    expect(t.bot.calls).toBe(1);
    expect(t.repo.botRequests("X-1")).toMatchObject([{ round: 1, status: "requested" }]);
    expect(t.svc.view("X-1").current).toBe("bot_review");
    expect(t.queued.get("workflow:X-1")?.body).toContain("已经请了 Copilot review");
  });

  it("a failed request is not done and hands the command to the session", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    t.bot.result = { ok: false, error: "HTTP 422: not eligible" };
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("bot_review");
    const body = t.queued.get("workflow:X-1")!.body;
    expect(body).toContain("HTTP 422");
    expect(body).toContain("gh api -X POST repos/o/a/pulls/1/copilot-code-review");
    // session 自己请了，bot 回来：照样认
    t.events.push(ev({ kind: "review", at: t.now() + 10, data: { id: 1, who: "copilot", author: "copilot-pull-request-reviewer", state: "COMMENTED", body: "x" } }));
    t.events.push(ev({ kind: "comment", at: t.now() + 10, data: { id: 2, reviewId: 1, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("address_comments");
  });

  it("in manual mode Shipherd doesn't call gh and asks the session instead", async () => {
    const t = setup({ level: "manual" });
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    expect(t.bot.calls).toBe(0);
    expect(t.repo.botRequests("X-1")).toMatchObject([{ status: "asked_session" }]);
    expect(t.queued.get("workflow:X-1")!.body).toContain("请你跑一下这条命令");
  });

  it("with the external-action switch off, the session asks and is told where the switch is (BTL-273)", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    t.bot.result = { ok: false, off: true, error: "external action pr_review_request is off" };
    await t.svc.evaluate("X-1");
    expect(t.repo.botRequests("X-1")).toMatchObject([{ status: "asked_session" }]);
    const body = t.queued.get("workflow:X-1")!.body;
    expect(body).toContain("对外动作 › 请 bot review");
    expect(body).toContain("gh api -X POST repos/o/a/pulls/1/copilot-code-review");
    // 不算失败：不会再去请第二次
    await t.svc.evaluate("X-1");
    expect(t.bot.calls).toBe(1);
  });

  it("asks again after the fixes are pushed, and stops at the round limit", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1, headSha: "s1" }));
    await t.svc.evaluate("X-1");
    t.events.push(ev({ kind: "review", at: t.now() + 10, data: { id: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    t.events.push(ev({ kind: "comment", at: t.now() + 10, data: { id: 8, reviewId: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("address_comments");
    t.svc.markStep("X-1", "address_comments", null);
    await t.svc.evaluate("X-1");
    // 还没 push：不再请
    expect(t.bot.calls).toBe(1);
    expect(t.svc.view("X-1").current).toBe("re_review");
    t.prs[0].headSha = "s2";
    t.tick(1000);
    await t.svc.evaluate("X-1");
    expect(t.bot.calls).toBe(2);
    expect(t.repo.botRequests("X-1").map((r) => [r.round, r.sha])).toEqual([[1, "s1"], [2, "s2"]]);
    // 第二轮又有意见，但已经到上限（再请 1 轮）：re_review 结束
    t.tick(1000);
    t.events.push(ev({ kind: "comment", at: t.now(), data: { id: 9, reviewId: 10, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("merge");
  });

  it("the last round's review landing just before the next request isn't taken as the new round's answer", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1, headSha: "s1" }));
    await t.svc.evaluate("X-1");
    // 第 1 轮的 review 很晚才到：离第 2 轮请求不到 60 秒
    t.tick(5 * 60_000);
    t.events.push(ev({ kind: "review", at: t.now(), data: { id: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    t.events.push(ev({ kind: "comment", at: t.now(), data: { id: 8, reviewId: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    await t.svc.evaluate("X-1");
    t.svc.markStep("X-1", "address_comments", null);
    t.prs[0].headSha = "s2";
    t.tick(20_000);
    await t.svc.evaluate("X-1");
    expect(t.bot.calls).toBe(2);
    // 第 1 轮 review 的行内评论晚到（在第 2 轮请求之后），仍算第 1 轮的
    t.tick(1000);
    t.events.push(ev({ kind: "comment", at: t.now(), data: { id: 9, reviewId: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    await t.svc.evaluate("X-1");
    const [r1, r2] = t.repo.botRequests("X-1");
    expect(r2.round).toBe(2);
    expect(r2.reviewedAt).toBeNull();
    expect(r1.reviewComments).toBe(2);
    expect(t.svc.view("X-1").current).toBe("re_review");
    // 第 2 轮真的回来了
    t.tick(1000);
    t.events.push(ev({ kind: "review", at: t.now(), data: { id: 10, who: "copilot", author: "copilot-pull-request-reviewer", body: "no comments" } }));
    t.events.push(ev({ kind: "comment", at: t.now(), data: { id: 11, reviewId: 10, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    await t.svc.evaluate("X-1");
    expect(t.repo.botRequests("X-1")[1].reviewedAt).toBe(t.now());
    expect(t.repo.botRequests("X-1")[1].reviewComments).toBe(1);
  });

  it("a Codex workflow isn't advanced by a Copilot review on the same PR", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, { steps: ["open_pr", { id: "bot_review", bot: "codex" }, "address_comments", "merge"] });
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    t.events.push(ev({ kind: "review", at: t.now() + 5, data: { id: 7, who: "copilot", author: "copilot-pull-request-reviewer", body: "no comments" } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("bot_review");
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: null })).not.toBeNull();
    t.events.push(ev({ kind: "comment", at: t.now() + 6, data: { id: 8, who: "copilot", author: "chatgpt-codex-connector", body: "Didn't find any major issues." } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("merge");
  });

  it("without an address-comments step, a clean bot answer completes re-review on its own", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, { steps: ["open_pr", "bot_review", "re_review", "merge"] });
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    t.events.push(ev({ kind: "review", at: t.now() + 5, data: { id: 7, who: "copilot", author: "copilot-pull-request-reviewer", body: "no comments" } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("merge");
  });

  it("a first round with no comments skips addressing and re-review", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    t.events.push(ev({ kind: "review", at: t.now() + 5, data: { id: 7, who: "copilot", author: "copilot-pull-request-reviewer", body: "no comments" } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("merge");
    expect(t.bot.calls).toBe(1);
  });

  it("a review whose inline comments couldn't be fetched stays open until gh counts them", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    // PR 监视拉行内评论失败：只记下了 review，没有行内评论
    t.events.push(ev({ kind: "review", at: t.now() + 5, data: { id: 7, who: "copilot", author: "copilot-pull-request-reviewer", state: "COMMENTED" } }));
    t.counts.result = null;
    await t.svc.evaluate("X-1");
    expect(t.counts.calls).toEqual([["7"]]);
    expect(t.svc.view("X-1").current).toBe("bot_review");
    expect(t.repo.botRequests("X-1")[0].reviewedAt).toBeNull();
    // 流程没走到合并：合并照样被拦
    expect(t.svc.merge({ ticketKey: "X-1", sessionId: null })).not.toBeNull();
    // gh 数到了 3 条：要处理意见
    t.counts.result = 3;
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("address_comments");
    expect(t.repo.botRequests("X-1")[0]).toMatchObject({ reviewComments: 3 });
  });

  it("inline comments that show up after the round was settled raise its count", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    t.events.push(ev({ kind: "review", at: t.now() + 5, data: { id: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    t.events.push(ev({ kind: "comment", at: t.now() + 5, data: { id: 8, reviewId: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    await t.svc.evaluate("X-1");
    t.events.push(ev({ kind: "comment", at: t.now() + 6, data: { id: 9, reviewId: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    await t.svc.evaluate("X-1");
    expect(t.repo.botRequests("X-1")[0]).toMatchObject({ reviewComments: 2 });
  });

  it("a request cut off by a quit is asked again after a restart", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    // 上次退出时 gh 还没回来：行停在 requesting
    t.repo.claimBotRequest("X-1", 1, 1, "copilot", "s1", t.now());
    await t.svc.evaluate("X-1");
    expect(t.bot.calls).toBe(0);
    const again = t.mk();
    again.recoverInterrupted();
    await again.evaluate("X-1");
    expect(t.bot.calls).toBe(1);
    expect(t.repo.botRequests("X-1")).toMatchObject([{ round: 1, status: "requested" }]);
  });

  it("won't take a session's step while an automatic step before it is still open", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    // bot 还没 review：不能先标「处理意见」
    expect(t.svc.markStep("X-1", "address_comments", null)).toMatchObject({ ok: false, message: expect.stringContaining("bot review") });
    expect(t.repo.done("X-1").map((d) => d.step)).not.toContain("address_comments");
    // 说明超长：拒绝，不截断
    t.events.push(ev({ kind: "review", at: t.now() + 5, data: { id: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    t.events.push(ev({ kind: "comment", at: t.now() + 5, data: { id: 8, reviewId: 7, who: "copilot", author: "copilot-pull-request-reviewer" } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.markStep("X-1", "address_comments", "x".repeat(501))).toMatchObject({ ok: false, message: expect.stringContaining("500") });
    expect(t.svc.markStep("X-1", "address_comments", "改好了")).toMatchObject({ ok: true });
  });

  it("a human comment isn't the bot's answer", async () => {
    const t = setup();
    t.svc.setLayer({ kind: "global" }, botFlow);
    t.prs.push(pr({ id: 1, ticketKey: "X-1", repoId: 1 }));
    await t.svc.evaluate("X-1");
    t.events.push(ev({ kind: "comment", at: t.now() + 5, data: { id: 3, reviewId: null, who: "human" } }));
    await t.svc.evaluate("X-1");
    expect(t.svc.view("X-1").current).toBe("bot_review");
  });
});

describe("WorkflowService: guide", () => {
  it("lists the steps, notes and the current step", () => {
    const t = setup();
    t.svc.setLayer({ kind: "feature", featureId: 4 }, { steps: ["implement", { id: "open_pr", note: "标题写 ticket 号" }, "ci_green", "merge"], notes: "别改版本号" });
    const g = t.svc.guideLines("X-1");
    expect(g[0]).toContain("epic「4.3.0」");
    expect(g).toContain("2. 开 PR：标题写 ticket 号");
    expect(g).toContain("4. 合并（总控来合）");
    expect(g).toContain("补充说明：别改版本号");
    expect(g.at(-1)).toBe("现在是「写代码」。");
    expect(t.svc.guideLines("NOPE-1")).toEqual([]);
  });
});

describe("splitBotRounds (BTL-273)", () => {
  const cp = (at: number[]) => at.map((requestedAt) => ({ requestedAt, bot: "copilot" as const }));
  const bot = (kind: "review" | "comment", at: number, data: Record<string, unknown>) => ev({ kind, at, data: { who: "copilot", author: "copilot-pull-request-reviewer", ...data } });

  it("a review within the slack before the next request belongs to the round that had no answer yet", () => {
    const [r1, r2] = splitBotRounds(cp([0, 100_000]), [bot("review", 70_000, { id: 1 })]);
    expect(r1.map((e) => e.data.id)).toEqual([1]);
    expect(r2).toEqual([]);
  });

  it("once the earlier round was answered, a review just before the next request (review on push) is the next round's", () => {
    const [r1, r2] = splitBotRounds(cp([0, 600_000]), [bot("review", 10_000, { id: 1 }), bot("review", 590_000, { id: 2 })]);
    expect(r1.map((e) => e.data.id)).toEqual([1]);
    expect(r2.map((e) => e.data.id)).toEqual([2]);
  });

  it("inline comments follow their review across round boundaries; humans are left out", () => {
    const [r1, r2] = splitBotRounds(
      cp([0, 600_000]),
      [bot("review", 10_000, { id: 1 }), bot("comment", 700_000, { id: 5, reviewId: 1 }), bot("comment", 700_000, { id: 6, reviewId: 2 }), ev({ kind: "review", at: 700_000, data: { id: 3, who: "human" } })],
    );
    expect(r1.map((e) => e.data.id)).toEqual([1, 5]);
    expect(r2.map((e) => e.data.id)).toEqual([6]);
  });

  it("each round only takes replies from the bot it asked: Copilot's review doesn't answer a Codex round", () => {
    const codex = (kind: "review" | "comment", at: number, data: Record<string, unknown>) => ev({ kind, at, data: { who: "copilot", author: "chatgpt-codex-connector", ...data } });
    const [c1, x1] = splitBotRounds(
      [{ requestedAt: 0, bot: "copilot" }, { requestedAt: 0, bot: "codex" }],
      [bot("review", 10_000, { id: 1 }), codex("comment", 20_000, { id: 2 })],
    );
    expect(c1.map((e) => e.data.id)).toEqual([1]);
    expect(x1.map((e) => e.data.id)).toEqual([2]);
    const [onlyCodex] = splitBotRounds([{ requestedAt: 0, bot: "codex" }], [bot("review", 10_000, { id: 1 })]);
    expect(onlyCodex).toEqual([]);
  });
});
