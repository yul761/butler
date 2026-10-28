import { describe, expect, it } from "vitest";
import type { FeatureHandoff, Handoff } from "../../shared/handoff";
import type { HandoffOutcome } from "../../shared/types";
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
import { FeatureSummaryRunner } from "./feature-runner";
import { ingestHandoff, type IngestInput } from "./ingest";
import { emptyHandoff, FEATURE_HANDOFF_JSON_SCHEMA } from "./schema";

const NOW = 50_000;
const WS = "/ws/login";

const summary = (over: Partial<FeatureHandoff> = {}): FeatureHandoff => ({
  summary: "前端做完，等后端", blockers: [], next_steps: [{ ticket: "A-1", text: "联调" }], decisions: [], open_questions: [], ...over,
});

const ok = (structured: unknown, sessionId = "fork-1"): HeadlessOutcome => ({
  ok: true,
  result: { sessionId, isError: false, subtype: "success", resultText: JSON.stringify(structured), structured, permissionDenials: [], apiErrorStatus: null, costUsd: 0 },
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
  let onChild: (key: string) => void = () => undefined;
  const ticketRunner = {
    candidates: () => ticketCandidates,
    runManual: async (key: string): Promise<HandoffOutcome> => {
      childRuns.push(key);
      order.push(`ticket:${key}`);
      onChild(key);
      return { ticketKey: key, status: "stored", handoffId: 1, degraded: false };
    },
  };
  const featureId = features.insert({ name: "登录改版", workspaceDir: WS, createdAt: 2 });
  const runner = new FeatureSummaryRunner({
    features, tickets, sessions, handoffs, featureHandoffs, settings,
    ingest: (i) => ingestFeatureHandoff({ features, tickets, featureHandoffs, now: () => clock }, i),
    ticketRunner,
    // 和 TicketService.featureHeadlessDirs 一样：工作区外的仓库目录才加 --add-dir。
    dirs: (id) => {
      const repoDirs = tickets.listByFeature(id).flatMap((t) => t.repos.map((r) => r.worktreePath ?? r.repoPath));
      return { cwd: features.get(id)!.workspaceDir, addDirs: repoDirs.filter((d) => !d.startsWith(`${WS}/`)), repoDirs };
    },
    run,
    ready: async () => undefined,
    claude: () => ({ path: "/bin/claude", pathValue: "/login/bin" }),
    baseEnv: { HOME: "/h" },
    transcriptMtime: (id) => mtimes[id] ?? null,
    now: () => clock,
    newRunId: () => "run-1",
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
  /** 总控 session；mtime 为 null 表示没有 transcript。 */
  const addCoordinator = (id: string, mtime: number | null, lastActivityAt = 1, fId: number = featureId) => {
    sessions.insertIfAbsent({ id, ticketKey: null, cwd: WS, origin: "butler", lastActivityAt, createdAt: 1, coordinator: true, featureId: fId });
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
    runner, features, tickets, sessions, featureHandoffs, featureId, calls, order, childRuns, addTicket, addCoordinator, ticketHandoff, addSummary,
    setRespond: (fn: typeof respond) => {
      respond = fn;
    },
    setTicketCandidates: (keys: string[]) => {
      ticketCandidates = keys;
    },
    setNow: (t: number) => {
      clock = t;
    },
    onChild: (fn: (key: string) => void) => {
      onChild = fn;
    },
  };
}

describe("FeatureSummaryRunner.candidates", () => {
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
    expect(req.env).toMatchObject({ BUTLER_SESSION: "headless:run-1", PATH: "/login/bin" });
    for (const s of ["登录改版", "A-1", "B-2", "#455 open", "和前端联调登录接口"]) expect(req.prompt).toContain(s);
    expect(sessions.get("fork-1")).toMatchObject({ dismissed: true });
    expect(featureHandoffs.latest(featureId)).toMatchObject({ trigger: "nightly", sessionId: "c-new", degraded: false, payload: summary() });
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
    setRespond(async () => ({ ok: false, reason: "rate_limited", message: "429", result: null }));
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
