import { describe, expect, it } from "vitest";
import type { FeatureHandoff, Handoff } from "../../shared/handoff";
import type { HandoffOutcome, WatchedPr } from "../../shared/types";
import type { HeadlessOutcome, HeadlessRequest, HeadlessRun } from "../claude/headless";
import { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import { FeaturesRepo } from "../db/features-repo";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { insertTicket, type LegacyTicket, memDb } from "../test-utils";
import { ingestFeatureHandoff } from "./feature-ingest";
import { featureCommandFollowup, FeatureSummaryRunner } from "./feature-runner";
import { ingestHandoff, type IngestInput } from "./ingest";
import { emptyHandoff, FEATURE_HANDOFF_JSON_SCHEMA } from "./schema";

const NOW = 50_000;
const WS = "/ws/login";

const summary = (over: Partial<FeatureHandoff> = {}): FeatureHandoff => ({
  summary: "前端做完，等后端", blockers: [], next_steps: [{ ticket: "A-1", text: "联调" }], decisions: [], open_questions: [], ...over,
});

const ok = (structured: unknown, sessionId = "fork-1"): HeadlessOutcome => ({
  ok: true,
  result: { sessionId, isError: false, subtype: "success", resultText: JSON.stringify(structured), structured, permissionDenials: [], apiErrorStatus: null, costUsd: 0, usage: null, model: null, durationMs: null },
});

function setup() {
  const db = memDb();
  const features = new FeaturesRepo(db);
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const settings = new SettingsRepo(db);
  const featureHandoffs = new FeatureHandoffsRepo(db);
  const mtimes: Record<string, number> = {};
  let clock = NOW;
  const order: string[] = [];
  const calls: HeadlessRequest[] = [];
  let respond: (req: HeadlessRequest, n: number) => Promise<HeadlessOutcome> = async () => ok(summary());
  const run: HeadlessRun = (req) => {
    calls.push(req);
    order.push("feature");
    return respond(req, calls.length);
  };
  let ticketCandidates: string[] = [];
  const childRuns: string[] = [];
  let onChild: (key: string) => unknown = () => undefined;
  const ticketRunner = {
    candidates: () => ticketCandidates,
    runManual: async (key: string): Promise<HandoffOutcome> => {
      childRuns.push(key);
      order.push(`ticket:${key}`);
      await onChild(key);
      return { ticketKey: key, status: "stored", handoffId: 1, degraded: false };
    },
  };
  const featureId = features.insert({ name: "登录改版", workspaceDir: WS, createdAt: 2 });
  const logs: string[] = [];
  const live: Record<string, WatchedPr[]> = {};
  const runner = new FeatureSummaryRunner({
    features, tickets, sessions, handoffs, featureHandoffs, settings,
    ingest: (i) => ingestFeatureHandoff({ features, tickets, featureHandoffs, now: () => clock }, i),
    ticketRunner,
    // 和 TicketService.featureHeadlessDirs 一样：工作区外的仓库目录才加 --add-dir。
    dirs: (id) => {
      const repoDirs = tickets.listWithFeature(features.get(id)!).flatMap((t) => t.repos.map((r) => r.worktreePath ?? r.repoPath));
      return { cwd: features.get(id)!.workspaceDir, addDirs: repoDirs.filter((d) => !d.startsWith(`${WS}/`)), repoDirs };
    },
    run,
    ready: async () => undefined,
    claude: () => ({ path: "/bin/claude", pathValue: "/login/bin" }),
    baseEnv: { HOME: "/h" },
    transcriptMtime: (id) => mtimes[id] ?? null,
    livePrs: (key) => live[key] ?? [],
    prTurns: () => (url) => (url === "https://github.com/o/web/pull/12" ? { owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: "s1" } : null),
    now: () => clock,
    newRunId: () => "run-1",
    log: (m) => logs.push(m),
  });
  let fid = 0;
  const ticketIngest = (input: IngestInput, at: number) => {
    const saved = clock;
    clock = at;
    ingestHandoff({ db, tickets, handoffs, followups, now: () => clock, newFollowupId: () => `f${++fid}` }, input);
    clock = saved;
  };
  const addTicket = (key: string, over: Partial<LegacyTicket> = {}, fId: number = featureId) =>
    insertTicket(tickets, {
      key, title: `标题 ${key}`, repoPath: `${WS}/web-${key.toLowerCase()}`, workMode: "branch", worktreePath: null, branch: `feature/${key}`,
      status: "active", statusManual: null, createdAt: 1, archivedAt: null, featureId: fId, ...over,
    });
  /** 修复 session：feature 下的行，但不是总控。 */
  const addFix = (id: string, mtime: number, lastActivityAt = 1) => {
    sessions.insertIfAbsent({ id, ticketKey: null, cwd: WS, origin: "shipherd", lastActivityAt, createdAt: 1, featureId, fixesSession: "stuck-1" });
    mtimes[id] = mtime;
  };
  /** 总控 session；mtime 为 null 表示没有 transcript。 */
  const addCoordinator = (id: string, mtime: number | null, lastActivityAt = 1, fId: number = featureId) => {
    sessions.insertIfAbsent({ id, ticketKey: null, cwd: WS, origin: "shipherd", lastActivityAt, createdAt: 1, coordinator: true, featureId: fId });
    if (mtime !== null) mtimes[id] = mtime;
  };
  const ticketHandoff = (key: string, at: number, over: Partial<Handoff> = {}, trigger: IngestInput["trigger"] = "nightly") =>
    ticketIngest({ ticketKey: key, sessionId: null, trigger, payload: { ...emptyHandoff(key), ...over }, rawText: null }, at);
  /** 一份已有的有效汇总。 */
  const addSummary = (at: number, coversUntil: number | null = null, fId: number = featureId) => {
    const id = featureHandoffs.insert({ featureId: fId, sessionId: null, trigger: "nightly", createdAt: at, payload: summary(), rawText: null })!;
    if (coversUntil !== null) featureHandoffs.setCoversUntil(id, coversUntil);
    return id;
  };
  return {
    runner, db, logs, live, features, tickets, sessions, featureHandoffs, featureId, calls, order, childRuns, mtimes, addTicket, addCoordinator, addFix, ticketHandoff, addSummary,
    setRespond: (fn: typeof respond) => {
      respond = fn;
    },
    setTicketCandidates: (keys: string[]) => {
      ticketCandidates = keys;
    },
    setNow: (t: number) => {
      clock = t;
    },
    onChild: (fn: (key: string) => unknown) => {
      onChild = fn;
    },
  };
}

describe("FeatureSummaryRunner.candidates", () => {
  it("does not count a fix session's transcript as coordinator activity", () => {
    const { runner, featureId, addCoordinator, addFix, addSummary } = setup();
    addSummary(100);
    addCoordinator("c-1", 50);
    addFix("fix-1", 200);
    expect(runner.candidates()).toEqual([]);
    addCoordinator("c-2", 200);
    expect(runner.candidates()).toEqual([featureId]);
  });

  it("picks a feature whose coordinator transcript changed after the latest valid summary", () => {
    const { runner, featureId, addCoordinator, addSummary } = setup();
    addSummary(100);
    addCoordinator("c-1", 50);
    expect(runner.candidates()).toEqual([]);
    addCoordinator("c-2", 200);
    expect(runner.candidates()).toEqual([featureId]);
  });

  it("picks a feature whose ticket captured a handoff after the summary's coversUntil", () => {
    const { runner, featureId, addTicket, ticketHandoff, addSummary } = setup();
    addTicket("A-1");
    addSummary(100, 300);
    ticketHandoff("A-1", 400);
    expect(runner.candidates()).toEqual([featureId]);
  });

  it("ignores refresh handoffs", () => {
    const { runner, addTicket, ticketHandoff, addSummary } = setup();
    addTicket("A-1");
    addSummary(100);
    ticketHandoff("A-1", 400, {}, "refresh");
    expect(runner.candidates()).toEqual([]);
  });

  it("ignores ticket handoffs that the summary already covers (coversUntil)", () => {
    const { runner, addTicket, ticketHandoff, addSummary } = setup();
    addTicket("A-1");
    addSummary(100, 300);
    ticketHandoff("A-1", 200);
    expect(runner.candidates()).toEqual([]);
  });

  it("picks a feature that never had a summary but has a coordinator transcript", () => {
    const { runner, featureId, addCoordinator } = setup();
    addCoordinator("c-1", 10);
    expect(runner.candidates()).toEqual([featureId]);
  });

  it("skips archived features", () => {
    const { runner, features, featureId, addCoordinator } = setup();
    addCoordinator("c-1", 10);
    features.archive(featureId, 5);
    expect(runner.candidates()).toEqual([]);
  });
});

/** 一个读到过的实时 PR 行（ws-b）。 */
const livePr = (ticketKey: string, statusChangedAt: number, o: Partial<WatchedPr> = {}): WatchedPr => ({
  ticketKey, prId: 1, repoId: 1, repoPath: "/r/web", branch: "b", number: 12, url: "https://github.com/o/web/pull/12", state: "open", review: "pending", ci: "failing",
  headSha: "s", checkedAt: statusChangedAt, readError: false,
  detail: {
    baseBranch: "main", isDraft: false, title: "t", author: "me", labels: [], reviewRequests: [], reviewers: [], mergeable: "mergeable", mergeState: "clean",
    statusChangedAt, slug: "o/web",
  },
  ...o,
});

describe("FeatureSummaryRunner: PR status counts as activity (ws-b)", () => {
  it("a PR status change after the summary read PRs makes the feature stale", () => {
    const { runner, featureId, featureHandoffs, addTicket, addSummary, live } = setup();
    addTicket("A-1");
    addSummary(100);
    live["A-1"] = [livePr("A-1", 90)];
    expect(runner.hasNewActivity(featureId)).toBe(false);
    live["A-1"] = [livePr("A-1", 150)];
    expect(runner.hasNewActivity(featureId)).toBe(true);
    expect(runner.candidates()).toEqual([featureId]);
    // 汇总记下了读 PR 的时间：按它算，不按 createdAt。
    featureHandoffs.insert({ featureId, sessionId: null, trigger: "manual", createdAt: 200, payload: summary(), rawText: null, prStatusAt: 160 });
    expect(runner.hasNewActivity(featureId)).toBe(false);
    live["A-1"] = [livePr("A-1", 170)];
    expect(runner.hasNewActivity(featureId)).toBe(true);
  });

  it("the prompt uses the live PR status with an as-of line, and the stored summary records when PRs were read", async () => {
    const { runner, featureId, calls, featureHandoffs, addTicket, addCoordinator, ticketHandoff, live, setNow } = setup();
    addTicket("A-1");
    addCoordinator("c-1", 10);
    ticketHandoff("A-1", 20, { prs: [{ number: 12, url: "https://github.com/o/web/pull/12", state: "open", review: null }, { number: 3, url: "https://github.com/o/api/pull/3", state: "merged", review: null }] });
    live["A-1"] = [livePr("A-1", 15)];
    setNow(60_000);
    expect(runner.isRunning(featureId)).toBe(false);
    const p = runner.runManual(featureId);
    expect(runner.isRunning(featureId)).toBe(true);
    await p;
    expect(runner.isRunning(featureId)).toBe(false);
    const prompt = calls[0].prompt;
    expect(prompt).toContain(`PR 状态截至 ${new Date(60_000).toISOString()}`);
    expect(prompt).toContain("web#12 open，CI failing，review pending，轮到：user (unattended: ci_failing)");
    expect(prompt).toContain("api#3 merged（handoff 里记的）");
    expect(prompt).not.toContain("web#12 open (pending)");
    expect(featureHandoffs.latestValid(featureId)?.prStatusAt).toBe(60_000);
  });
});

describe("FeatureSummaryRunner generation", () => {
  it("forks the latest coordinator session in the workspace with the outside repos added", async () => {
    const { runner, featureId, calls, featureHandoffs, sessions, addTicket, addCoordinator, ticketHandoff } = setup();
    addTicket("A-1", { repoPath: "/r/api" });
    addTicket("B-2");
    ticketHandoff("A-1", 10, {
      prs: [{ number: 455, url: "https://github.com/acme/api/pull/455", state: "open", review: "pending" }],
      next_steps: ["和前端联调登录接口"],
    });
    addCoordinator("c-old", 20, 1);
    addCoordinator("c-new", 30, 5);
    addCoordinator("c-hidden", 40, 9);
    sessions.dismiss("c-hidden");
    const batch = await runner.runNightly();
    expect(batch).toMatchObject({ status: "ok", outcomes: [{ featureId, status: "stored", degraded: false }] });
    const [req] = calls;
    expect(req.cwd).toBe(WS);
    expect(req.args.slice(0, 13)).toEqual([
      "-p", "--output-format", "json", "--json-schema", FEATURE_HANDOFF_JSON_SCHEMA, "--no-session-persistence", "--permission-mode", "dontAsk", "--setting-sources", "user",
      "--resume", "c-new", "--fork-session",
    ]);
    expect(req.args.filter((a, i) => req.args[i - 1] === "--add-dir")).toEqual(["/r/api"]);
    expect(req.env).toMatchObject({ SHIPHERD_SESSION: "headless:run-1", PATH: "/login/bin" });
    for (const s of ["登录改版", "A-1", "B-2", "#455 open", "和前端联调登录接口"]) expect(req.prompt).toContain(s);
    expect(sessions.get("fork-1")).toMatchObject({ dismissed: true });
    expect(featureHandoffs.latest(featureId)).toMatchObject({ trigger: "nightly", sessionId: "c-new", degraded: false, payload: summary() });
  });

  it("forks the coordinator with its own model, and without --model when it has none", async () => {
    const { runner, calls, sessions, addCoordinator, ticketHandoff, addTicket, mtimes } = setup();
    addTicket("A-1");
    ticketHandoff("A-1", 10, {});
    addCoordinator("c-1", 20, 1);
    await runner.runNightly();
    expect(calls[0].args).not.toContain("--model");
    sessions.insertIfAbsent({ id: "c-2", ticketKey: null, cwd: WS, origin: "shipherd", lastActivityAt: 9, createdAt: 1, coordinator: true, featureId: sessions.get("c-1")!.featureId!, model: "opus" });
    mtimes["c-2"] = 1e12;
    await runner.runNightly();
    const args = calls[1].args;
    expect(args).toContain("c-2");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "opus"]);
  });

  it("runs fresh in the workspace when there is no coordinator session", async () => {
    const { runner, featureId, calls, featureHandoffs, addTicket, ticketHandoff } = setup();
    addTicket("A-1");
    ticketHandoff("A-1", 10, { next_steps: ["写测试"] });
    expect(await runner.runManual(featureId)).toMatchObject({ status: "stored" });
    expect(calls[0].args).not.toContain("--resume");
    expect(calls[0].cwd).toBe(WS);
    expect(featureHandoffs.latest(featureId)).toMatchObject({ trigger: "manual", sessionId: null });
  });

  it("resumes the coordinator, not a more recent fix session", async () => {
    const { runner, featureId, calls, featureHandoffs, addCoordinator, addFix } = setup();
    addCoordinator("c-1", 30, 5);
    addFix("fix-1", 40, 9);
    expect(await runner.runManual(featureId)).toMatchObject({ status: "stored" });
    expect(calls[0].args).toContain("c-1");
    expect(calls[0].args).not.toContain("fix-1");
    expect(featureHandoffs.latest(featureId)).toMatchObject({ sessionId: "c-1" });
  });

  it("does not resume a fix session when there is no coordinator", async () => {
    const { runner, featureId, calls, addFix } = setup();
    addFix("fix-1", 40);
    expect(await runner.runManual(featureId)).toEqual({ featureId, status: "skipped", reason: "nothing_to_summarize" });
    expect(calls).toHaveLength(0);
  });

  it("generates from the coordinator conversation alone when the feature has no tickets", async () => {
    const { runner, featureId, calls, featureHandoffs, addCoordinator } = setup();
    addCoordinator("c-1", 30);
    expect(await runner.runManual(featureId)).toMatchObject({ status: "stored", degraded: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).not.toContain("--add-dir");
    expect(calls[0].args).toContain("--resume");
    expect(featureHandoffs.latest(featureId)).toMatchObject({ trigger: "manual", sessionId: "c-1" });
  });

  it("retries once with the validation errors, then stores a valid summary", async () => {
    const { runner, featureId, calls, featureHandoffs, addCoordinator, setRespond } = setup();
    addCoordinator("c-1", 30);
    setRespond(async (_req, n) => (n === 1 ? ok({ foo: 1 }) : ok(summary())));
    expect(await runner.runManual(featureId)).toMatchObject({ status: "stored", degraded: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain("上一次的输出没有通过校验");
    expect(featureHandoffs.listByFeature(featureId)).toHaveLength(1);
  });

  it("stores a degraded summary with the raw text when the retry is invalid too", async () => {
    const { runner, featureId, calls, featureHandoffs, addCoordinator, setRespond } = setup();
    addCoordinator("c-1", 30);
    setRespond(async () => ok({ foo: 1 }));
    expect(await runner.runManual(featureId)).toMatchObject({ status: "stored", degraded: true });
    expect(calls).toHaveLength(2);
    expect(featureHandoffs.latest(featureId)).toMatchObject({ degraded: true, rawText: '{"foo":1}', payload: null });
  });

  it("puts the previous valid summary into the prompt", async () => {
    const { runner, featureId, calls, addCoordinator, addSummary } = setup();
    addSummary(10);
    addCoordinator("c-1", 30);
    await runner.runManual(featureId);
    expect(calls[0].prompt).toContain("前端做完，等后端");
  });
});

describe("FeatureSummaryRunner.runNightly", () => {
  it("runs only the candidates, and skips the rest after a rate limit", async () => {
    const { runner, features, featureId, calls, addCoordinator, setRespond } = setup();
    const second = features.insert({ name: "支付", workspaceDir: "/ws/pay", createdAt: 1 });
    const idle = features.insert({ name: "空闲", workspaceDir: "/ws/idle", createdAt: 0 });
    addCoordinator("c-1", 30, 1, featureId);
    addCoordinator("c-2", 30, 1, second);
    addCoordinator("c-3", null, 1, idle);
    setRespond(async () => ({ ok: false, reason: "rate_limited", message: "429", result: null, limit: null, stderr: "" }));
    const batch = await runner.runNightly();
    expect(batch.status).toBe("partial");
    expect(batch.outcomes).toEqual([
      { featureId, status: "skipped", reason: "rate_limited" },
      { featureId: second, status: "skipped", reason: "rate_limited" },
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe("FeatureSummaryRunner.runManual", () => {
  it("first runs the feature's active tickets, then the summary", async () => {
    const { runner, features, featureId, order, childRuns, featureHandoffs, addTicket, addCoordinator, setTicketCandidates } = setup();
    addTicket("A-1");
    addTicket("B-2");
    addTicket("X-9", {}, features.insert({ name: "别的", workspaceDir: "/ws/other", createdAt: 1 }));
    addCoordinator("c-1", 30);
    setTicketCandidates(["A-1", "X-9"]);
    expect(await runner.runManual(featureId)).toMatchObject({ status: "stored" });
    expect(childRuns).toEqual(["A-1"]);
    expect(order).toEqual(["ticket:A-1", "feature"]);
    expect(featureHandoffs.latest(featureId)?.trigger).toBe("manual");
  });

  it("skips without spending anything when there is no coordinator session and no ticket handoff", async () => {
    const { runner, featureId, calls, addTicket } = setup();
    addTicket("A-1");
    expect(await runner.runManual(featureId)).toEqual({ featureId, status: "skipped", reason: "nothing_to_summarize" });
    expect(calls).toHaveLength(0);
  });

  it("shares one run when the same feature is requested twice at once", async () => {
    const { runner, featureId, calls, addCoordinator } = setup();
    addCoordinator("c-1", 30);
    const [a, b] = await Promise.all([runner.runManual(featureId), runner.runManual(featureId)]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });
});

describe("FeatureSummaryRunner.hasNewActivity", () => {
  it("counts the same activity as candidates", () => {
    const { runner, featureId, features, addCoordinator, addSummary, addTicket, ticketHandoff } = setup();
    const quiet = features.insert({ name: "没动静", workspaceDir: "/ws/quiet", createdAt: 2 });
    expect(runner.hasNewActivity(featureId)).toBe(false);
    addCoordinator("c-1", 100);
    expect(runner.hasNewActivity(featureId)).toBe(true);
    addSummary(200);
    expect(runner.hasNewActivity(featureId)).toBe(false);
    addTicket("A-1");
    ticketHandoff("A-1", 300);
    expect(runner.hasNewActivity(featureId)).toBe(true);
    expect(runner.hasNewActivity(quiet)).toBe(false);
    expect(runner.candidates()).toEqual([featureId]);
  });

  it("leaves the nightly batch alone: the ticket batch runs first, and a ticket it could not capture adds nothing new to summarize", async () => {
    const { runner, featureId, calls, addSummary, addTicket, setTicketCandidates } = setup();
    addSummary(200);
    addTicket("A-1");
    setTicketCandidates(["A-1"]);
    expect(runner.hasNewActivity(featureId)).toBe(false);
    expect(runner.candidates()).toEqual([]);
    expect(await runner.runNightly()).toEqual({ status: "ok", outcomes: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("FeatureSummaryRunner.afterCommand", () => {
  it("runs the active tickets, then marks the summary as covering up to now", async () => {
    const { runner, featureId, featureHandoffs, childRuns, addTicket, addSummary, setTicketCandidates, setNow, onChild } = setup();
    addTicket("A-1");
    setTicketCandidates(["A-1"]);
    const id = addSummary(100);
    const seen: (number | null)[] = [];
    onChild(() => seen.push(featureHandoffs.get(id)!.coversUntil));
    setNow(900);
    await runner.afterCommand(featureId, id);
    expect(childRuns).toEqual(["A-1"]);
    expect(seen).toEqual([null]);
    expect(featureHandoffs.get(id)?.coversUntil).toBe(900);
  });

  it("only runs the tickets when nothing was stored", async () => {
    const { runner, featureId, featureHandoffs, childRuns, addTicket, addSummary, setTicketCandidates } = setup();
    addTicket("A-1");
    setTicketCandidates(["A-1"]);
    const id = addSummary(100);
    await runner.afterCommand(featureId, null);
    expect(childRuns).toEqual(["A-1"]);
    expect(featureHandoffs.get(id)?.coversUntil).toBeNull();
  });
});

describe("FeatureSummaryRunner.runFromCommand", () => {
  it("forks the session that ran /handoff (not the most recent one), stores a command summary, then runs the children and sets coversUntil", async () => {
    const { runner, featureId, calls, order, childRuns, featureHandoffs, addTicket, addCoordinator, setTicketCandidates, setNow, onChild } = setup();
    addTicket("A-1");
    setTicketCandidates(["A-1"]);
    addCoordinator("c-mine", 20, 1);
    addCoordinator("c-new", 30, 5);
    const seen: (number | null)[] = [];
    onChild(() => seen.push(featureHandoffs.latest(featureId)!.coversUntil));
    setNow(900);
    const o = await runner.runFromCommand(featureId, "c-mine");
    expect(o).toMatchObject({ featureId, status: "stored", degraded: false });
    expect(calls).toHaveLength(1);
    const resume = calls[0].args.indexOf("--resume");
    expect(calls[0].args.slice(resume, resume + 3)).toEqual(["--resume", "c-mine", "--fork-session"]);
    expect(calls[0].args[calls[0].args.indexOf("--json-schema") + 1]).toBe(FEATURE_HANDOFF_JSON_SCHEMA);
    expect(calls[0].cwd).toBe(WS);
    expect(order).toEqual(["feature", "ticket:A-1"]);
    expect(childRuns).toEqual(["A-1"]);
    expect(seen).toEqual([null]);
    expect(featureHandoffs.latest(featureId)).toMatchObject({ trigger: "command", sessionId: "c-mine", coversUntil: 900, payload: summary() });
    expect(o.status === "stored" && o.handoffId).toBe(featureHandoffs.latest(featureId)?.id);
  });

  it("validates and retries like the other runs", async () => {
    const { runner, featureId, calls, featureHandoffs, addCoordinator, setRespond } = setup();
    addCoordinator("c-1", 30);
    setRespond(async (_req, n) => (n === 1 ? ok({ ...summary(), summary: "  " }) : ok(summary())));
    expect(await runner.runFromCommand(featureId, "c-1")).toMatchObject({ status: "stored", degraded: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain("上一次的输出没有通过校验");
    expect(featureHandoffs.listByFeature(featureId)).toHaveLength(1);
  });

  it("still runs the children when nothing was stored, without touching coversUntil", async () => {
    const { runner, featureId, childRuns, featureHandoffs, addTicket, addCoordinator, addSummary, setRespond, setTicketCandidates } = setup();
    addTicket("A-1");
    setTicketCandidates(["A-1"]);
    addCoordinator("c-1", 30);
    const old = addSummary(10);
    setRespond(async () => ({ ok: false, reason: "rate_limited", message: "429", result: null, limit: null, stderr: "" }));
    expect(await runner.runFromCommand(featureId, "c-1")).toEqual({ featureId, status: "skipped", reason: "rate_limited" });
    expect(childRuns).toEqual(["A-1"]);
    expect(featureHandoffs.get(old)?.coversUntil).toBeNull();
    expect(featureHandoffs.listByFeature(featureId)).toHaveLength(1);
  });

  it("shares the run with a manual update of the same feature that is already going", async () => {
    const { runner, featureId, calls, featureHandoffs, addCoordinator } = setup();
    addCoordinator("c-1", 30);
    const [a, b] = await Promise.all([runner.runManual(featureId), runner.runFromCommand(featureId, "c-1")]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
    expect(featureHandoffs.listByFeature(featureId)).toHaveLength(1);
  });
});

describe("featureCommandFollowup (capture → runner wiring in index.ts)", () => {
  const harness = () => {
    const log: string[] = [];
    const seen: string[] = [];
    let notified = 0;
    const runner = {
      afterCommand: async (featureId: number, handoffId: number | null) => void seen.push(`after:${featureId}:${handoffId}`),
      runFromCommand: async (featureId: number, sessionId: string) => {
        seen.push(`from:${featureId}:${sessionId}`);
        return { featureId, status: "stored" as const, handoffId: 7, degraded: false };
      },
    };
    const follow = featureCommandFollowup(runner, { notify: () => void notified++, log: (m) => void log.push(m) });
    return { follow, log, seen, notified: () => notified };
  };

  it("only runs the children when /handoff stored a summary", async () => {
    const h = harness();
    h.follow(3, 12, "c1");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.seen).toEqual(["after:3:12"]);
    expect(h.notified()).toBe(1);
  });

  it("generates the summary itself from that session when /handoff stored nothing, and logs that the fallback ran", async () => {
    const h = harness();
    h.follow(3, null, "c1");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.seen).toEqual(["from:3:c1"]);
    expect(h.log.some((m) => m.includes("feature 3") && m.includes("c1") && m.includes("fallback"))).toBe(true);
    expect(h.notified()).toBe(1);
  });
});
