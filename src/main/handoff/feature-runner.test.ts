import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureHandoff, Handoff } from "../../shared/handoff";
import type { HandoffOutcome } from "../../shared/types";
import type { HeadlessOutcome, HeadlessRequest, HeadlessRun } from "../claude/headless";
import { EpicsRepo } from "../db/epics-repo";
import { FeatureHandoffsRepo } from "../db/feature-handoffs-repo";
import { FeaturesRepo } from "../db/features-repo";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { insertTicket, type LegacyTicket, memDb } from "../test-utils";
import { FeatureService } from "../tickets/feature-service";
import { ingestFeatureHandoff } from "./feature-ingest";
import { ARCHIVE_SUMMARY_LIMIT_MS, featureCommandFollowup, FeatureSummaryRunner } from "./feature-runner";
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
    sessions.insertIfAbsent({ id, ticketKey: null, cwd: WS, origin: "butler", lastActivityAt, createdAt: 1, featureId, fixesSession: "stuck-1" });
    mtimes[id] = mtime;
  };
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
    runner, db, logs, features, tickets, sessions, featureHandoffs, featureId, calls, order, childRuns, addTicket, addCoordinator, addFix, ticketHandoff, addSummary,
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

describe("FeatureSummaryRunner.staleFeature", () => {
  it("counts the same activity as candidates", () => {
    const { runner, featureId, features, addCoordinator, addSummary, addTicket, ticketHandoff } = setup();
    const quiet = features.insert({ name: "没动静", workspaceDir: "/ws/quiet", createdAt: 2 });
    expect(runner.staleFeature(featureId)).toBe(false);
    addCoordinator("c-1", 100);
    expect(runner.staleFeature(featureId)).toBe(true);
    addSummary(200);
    expect(runner.staleFeature(featureId)).toBe(false);
    addTicket("A-1");
    ticketHandoff("A-1", 300);
    expect(runner.staleFeature(featureId)).toBe(true);
    expect(runner.staleFeature(quiet)).toBe(false);
    expect(runner.candidates()).toEqual([featureId]);
  });

  it("also counts a ticket session that was used without a /handoff", () => {
    const { runner, featureId, features, addSummary, addTicket, setTicketCandidates } = setup();
    addSummary(200);
    addTicket("A-1");
    addTicket("X-9", {}, features.insert({ name: "别的", workspaceDir: "/ws/other", createdAt: 1 }));
    expect(runner.staleFeature(featureId)).toBe(false);
    setTicketCandidates(["X-9"]);
    expect(runner.staleFeature(featureId)).toBe(false);
    setTicketCandidates(["A-1"]);
    expect(runner.staleFeature(featureId)).toBe(true);
  });

  it("leaves the nightly batch alone: the ticket batch runs first, and a ticket it could not capture adds nothing new to summarize", async () => {
    const { runner, featureId, calls, addSummary, addTicket, setTicketCandidates } = setup();
    addSummary(200);
    addTicket("A-1");
    setTicketCandidates(["A-1"]);
    expect(runner.staleFeature(featureId)).toBe(true);
    expect(runner.candidates()).toEqual([]);
    expect(await runner.runNightly()).toEqual({ status: "ok", outcomes: [] });
    expect(calls).toHaveLength(0);
  });
});

/** 同一个 epic 下几个 feature。 */
function epicSetup() {
  const ctx = setup();
  const epicId = new EpicsRepo(ctx.db).insert({ name: "e", workspaceDir: "/e", createdAt: 1 });
  ctx.features.setEpic(ctx.featureId, epicId);
  const add = (name: string) => ctx.features.insert({ name, workspaceDir: `/ws/${name}`, createdAt: 2, epicId });
  return { ...ctx, epicId, add };
}

describe("FeatureSummaryRunner.refreshEpic", () => {
  it("runs the stale features of the epic in the background, and returns at once", async () => {
    const { runner, epicId, featureId, features, add, addCoordinator, addSummary, setRespond, featureHandoffs, calls } = epicSetup();
    const stale = add("过期");
    const fresh = add("没变");
    const other = features.insert({ name: "别的 epic", workspaceDir: "/ws/other", createdAt: 2 });
    addCoordinator("c-1", 30, 1, featureId);
    addCoordinator("c-2", 30, 1, stale);
    addCoordinator("c-3", 30, 1, fresh);
    addSummary(40, null, fresh);
    addCoordinator("c-4", 30, 1, other);
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((r) => (finish = r));
    setRespond(async () => {
      await gate;
      return ok(summary());
    });
    expect(runner.refreshEpic(epicId)).toBeUndefined();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(featureHandoffs.latest(stale)).toBeNull();
    finish();
    await vi.waitFor(() => expect(featureHandoffs.latest(stale)?.trigger).toBe("manual"));
    await vi.waitFor(() => expect(featureHandoffs.latest(featureId)).not.toBeNull());
    expect(featureHandoffs.latest(fresh)?.trigger).toBe("nightly");
    expect(featureHandoffs.latest(other)).toBeNull();
    expect(runner.candidates()).toEqual([other]);
  });

  it("skips the feature it was told to, and archived features", async () => {
    const { runner, epicId, featureId, features, add, addCoordinator, calls } = epicSetup();
    const gone = add("归档了");
    addCoordinator("c-1", 30, 1, featureId);
    addCoordinator("c-2", 30, 1, gone);
    features.archive(gone, 5);
    runner.refreshEpic(epicId, featureId);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0);
  });

  it("logs a failed run and does not stop the others", async () => {
    const { runner, epicId, featureId, add, addCoordinator, setRespond, logs, featureHandoffs } = epicSetup();
    const second = add("第二个");
    addCoordinator("c-1", 30, 1, featureId);
    addCoordinator("c-2", 30, 1, second);
    setRespond(async (_req, n) => (n === 1 ? { ok: false, reason: "failed", message: "boom" } as never : ok(summary())));
    runner.refreshEpic(epicId);
    await vi.waitFor(() => expect(logs.join("\n")).toContain("failed"));
    await vi.waitFor(() => expect(featureHandoffs.latest(featureId) ?? featureHandoffs.latest(second)).not.toBeNull());
  });

  it("logs instead of throwing when the features cannot be read", async () => {
    const { runner, epicId, features, logs } = epicSetup();
    vi.spyOn(features, "listByEpic").mockImplementation(() => {
      throw new Error("db gone");
    });
    expect(() => runner.refreshEpic(epicId)).not.toThrow();
    await vi.waitFor(() => expect(logs.join("\n")).toContain(`epic ${epicId}`));
  });

  it("summarizes a feature whose only news is in a ticket session, with that ticket's handoff in the prompt", async () => {
    const { runner, epicId, featureId, calls, childRuns, featureHandoffs, addTicket, addSummary, ticketHandoff, setTicketCandidates, onChild } = epicSetup();
    addSummary(40);
    addTicket("A-1");
    setTicketCandidates(["A-1"]);
    onChild((key) => ticketHandoff(key, 45, { next_steps: ["今天做到一半的退款接口"] }));
    runner.refreshEpic(epicId);
    await vi.waitFor(() => expect(featureHandoffs.latest(featureId)?.trigger).toBe("manual"));
    expect(childRuns).toEqual(["A-1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("今天做到一半的退款接口");
  });

  describe("the run in flight, per epic", () => {
    it("is there while the summaries run, ends after they are stored, and is gone afterwards", async () => {
      const { runner, epicId, featureId, addCoordinator, setRespond, featureHandoffs, calls } = epicSetup();
      addCoordinator("c-1", 30, 1, featureId);
      let finish: () => void = () => undefined;
      const gate = new Promise<void>((r) => (finish = r));
      setRespond(async () => {
        await gate;
        return ok(summary());
      });
      expect(runner.epicRefresh(epicId)).toBeUndefined();
      runner.refreshEpic(epicId);
      const inflight = runner.epicRefresh(epicId);
      expect(inflight).toBeInstanceOf(Promise);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      finish();
      await inflight;
      expect(featureHandoffs.latest(featureId)).not.toBeNull();
      expect(runner.epicRefresh(epicId)).toBeUndefined();
    });

    it("is kept per epic", async () => {
      const { runner, db, epicId, featureId, features, addCoordinator, setRespond } = epicSetup();
      const otherEpic = new EpicsRepo(db).insert({ name: "另一个", workspaceDir: "/e2", createdAt: 1 });
      features.insert({ name: "别的", workspaceDir: "/ws/o", createdAt: 2, epicId: otherEpic });
      addCoordinator("c-1", 30, 1, featureId);
      setRespond(() => new Promise(() => undefined));
      runner.refreshEpic(epicId);
      expect(runner.epicRefresh(epicId)).toBeDefined();
      expect(runner.epicRefresh(otherEpic)).toBeUndefined();
    });

    it("covers a second refresh that starts while the first still runs", async () => {
      const { runner, epicId, featureId, add, addCoordinator, setRespond, featureHandoffs, calls } = epicSetup();
      const second = add("第二个");
      addCoordinator("c-1", 30, 1, featureId);
      const release: (() => void)[] = [];
      setRespond(async () => {
        await new Promise<void>((r) => release.push(r));
        return ok(summary());
      });
      // 第一次跳过 second，第二次跳过 featureId：两次各跑一个。
      runner.refreshEpic(epicId, second);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      addCoordinator("c-2", 30, 1, second);
      runner.refreshEpic(epicId, featureId);
      const inflight = runner.epicRefresh(epicId)!;
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      let done = false;
      void inflight.then(() => (done = true));
      release[1]();
      await vi.waitFor(() => expect(featureHandoffs.latest(second)).not.toBeNull());
      await new Promise((r) => setTimeout(r, 0));
      expect(done).toBe(false);
      expect(runner.epicRefresh(epicId)).toBe(inflight);
      release[0]();
      await inflight;
      expect(runner.epicRefresh(epicId)).toBeUndefined();
    });

    it("resolves when a run fails", async () => {
      const { runner, epicId, features } = epicSetup();
      vi.spyOn(features, "listByEpic").mockImplementation(() => {
        throw new Error("db gone");
      });
      runner.refreshEpic(epicId);
      await expect(runner.epicRefresh(epicId)).resolves.toBeUndefined();
      expect(runner.epicRefresh(epicId)).toBeUndefined();
    });
  });
});

describe("FeatureSummaryRunner.refreshBeforeArchive", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for the stale features and leaves the fresh ones alone", async () => {
    const { runner, featureId, add, addCoordinator, addSummary, featureHandoffs, calls } = epicSetup();
    const fresh = add("没变");
    addCoordinator("c-1", 30, 1, featureId);
    addCoordinator("c-2", 30, 1, fresh);
    addSummary(40, null, fresh);
    await runner.refreshBeforeArchive([featureId, fresh]);
    expect(calls).toHaveLength(1);
    expect(featureHandoffs.latest(featureId)?.trigger).toBe("manual");
  });

  it("logs a failure and resolves", async () => {
    const { runner, featureId, addCoordinator, setRespond, logs } = epicSetup();
    addCoordinator("c-1", 30, 1, featureId);
    setRespond(() => Promise.reject(new Error("boom")));
    await runner.refreshBeforeArchive([featureId]);
    expect(logs.join("\n")).toContain(`feature summary ${featureId}: failed`);
  });

  it("gives up after the shared limit, starts nothing more, and lets the running ones finish in the background", async () => {
    vi.useFakeTimers();
    const { runner, featureId, add, addCoordinator, setRespond, featureHandoffs, calls, logs } = epicSetup();
    const second = add("第二个");
    const third = add("第三个");
    addCoordinator("c-1", 30, 1, featureId);
    addCoordinator("c-2", 30, 1, second);
    addCoordinator("c-3", 30, 1, third);
    const release: (() => void)[] = [];
    setRespond(async () => {
      await new Promise<void>((r) => release.push(r));
      return ok(summary());
    });
    let done = false;
    const p = runner.refreshBeforeArchive([featureId, second, third]).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(ARCHIVE_SUMMARY_LIMIT_MS - 1);
    expect(done).toBe(false);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(logs.join("\n")).toContain("timed out");
    for (const r of release) r();
    await vi.advanceTimersByTimeAsync(1000);
    expect(featureHandoffs.latest(featureId)).not.toBeNull();
    expect(featureHandoffs.latest(third)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("leaves no timer behind", async () => {
    vi.useFakeTimers();
    const { runner, featureId, addCoordinator } = epicSetup();
    addCoordinator("c-1", 30, 1, featureId);
    const p = runner.refreshBeforeArchive([featureId]);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("archiving a feature with the real runner", () => {
  /** epic 下的 feature，有活动的总控和一个 ticket；runner 接到 FeatureService 上，和 index.ts 一样。 */
  function archiveSetup() {
    const ctx = epicSetup();
    ctx.addCoordinator("c-1", 30);
    ctx.addTicket("A-1");
    const svc = new FeatureService({ features: ctx.features, tickets: ctx.tickets, now: () => 60_000, refreshBeforeArchive: (ids) => ctx.runner.refreshBeforeArchive(ids), log: (m) => ctx.logs.push(m) });
    return { ...ctx, svc };
  }
  const closed = { terminalsOpen: () => false };

  it("summarizes with the tickets still in the prompt, then archives", async () => {
    const { svc, features, tickets, featureId, featureHandoffs, setRespond } = archiveSetup();
    const prompts: string[] = [];
    setRespond(async (req) => {
      prompts.push(req.prompt);
      expect(features.get(featureId)?.archivedAt).toBeNull();
      return ok(summary());
    });
    await svc.archive(featureId, closed);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("A-1");
    expect(featureHandoffs.latest(featureId)?.trigger).toBe("manual");
    expect(features.get(featureId)?.archivedAt).toBe(60_000);
    expect(tickets.listByFeature(featureId)).toEqual([]);
  });

  it("archives anyway when the summary fails, and logs it", async () => {
    const { svc, features, featureId, setRespond, logs } = archiveSetup();
    setRespond(() => Promise.reject(new Error("boom")));
    await svc.archive(featureId, closed);
    expect(features.get(featureId)?.archivedAt).toBe(60_000);
    expect(logs.join("\n")).toContain(`feature summary ${featureId}: failed`);
  });

  it("runs one summary for two clicks", async () => {
    const { svc, featureId, calls } = archiveSetup();
    await Promise.all([svc.archive(featureId, closed), svc.archive(featureId, closed)]);
    expect(calls).toHaveLength(1);
  });

  it("spends nothing when nothing changed since the last summary", async () => {
    const { svc, features, featureId, addSummary, calls } = archiveSetup();
    addSummary(40);
    await svc.archive(featureId, closed);
    expect(calls).toHaveLength(0);
    expect(features.get(featureId)?.archivedAt).toBe(60_000);
  });

  it("runs the ticket session's handoff and summarizes before archiving when only a ticket session was used", async () => {
    const { svc, features, featureId, featureHandoffs, childRuns, calls, addSummary, ticketHandoff, setTicketCandidates, onChild } = archiveSetup();
    addSummary(40);
    setTicketCandidates(["A-1"]);
    onChild((key) => {
      expect(features.get(featureId)?.archivedAt).toBeNull();
      ticketHandoff(key, 45, { next_steps: ["今天做到一半的退款接口"] });
    });
    await svc.archive(featureId, closed);
    expect(childRuns).toEqual(["A-1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain("今天做到一半的退款接口");
    expect(featureHandoffs.latest(featureId)?.trigger).toBe("manual");
    expect(features.get(featureId)?.archivedAt).toBe(60_000);
  });

  it("spends nothing on a feature outside any epic", async () => {
    const { svc, features, featureId, calls } = archiveSetup();
    features.setEpic(featureId, null);
    await svc.archive(featureId, closed);
    expect(calls).toHaveLength(0);
    expect(features.get(featureId)?.archivedAt).toBe(60_000);
  });

  describe("when the limit expires while the child tickets still run", () => {
    afterEach(() => vi.useRealTimers());

    /** 子 ticket 卡到限时之后：归档先生效，汇总这时才开始。 */
    async function archiveDuringChildren(ctx: ReturnType<typeof archiveSetup>) {
      vi.useFakeTimers();
      let release: () => void = () => undefined;
      ctx.setTicketCandidates(["A-1"]);
      ctx.onChild(() => new Promise<void>((r) => (release = r)));
      const p = ctx.svc.archive(ctx.featureId, closed);
      await vi.advanceTimersByTimeAsync(ARCHIVE_SUMMARY_LIMIT_MS);
      await p;
      expect(ctx.features.get(ctx.featureId)?.archivedAt).toBe(60_000);
      expect(ctx.tickets.get("A-1")?.archivedAt).toBe(60_000);
      expect(ctx.calls).toHaveLength(0);
      release();
      await vi.advanceTimersByTimeAsync(1000);
    }

    it("still writes the tickets archived with the feature into the late summary", async () => {
      const ctx = archiveSetup();
      ctx.addTicket("B-2", { repoPath: "/elsewhere/web" });
      await archiveDuringChildren(ctx);
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.calls[0].prompt).toContain("A-1");
      expect(ctx.calls[0].prompt).toContain("B-2");
      expect(ctx.calls[0].args.join(" ")).toContain("/elsewhere/web");
      expect(ctx.featureHandoffs.latest(ctx.featureId)?.trigger).toBe("manual");
    });

    it("leaves out a ticket that was archived on its own before", async () => {
      const ctx = archiveSetup();
      ctx.addTicket("OLD-1", { archivedAt: 7, repoPath: "/elsewhere/old" });
      await archiveDuringChildren(ctx);
      expect(ctx.calls[0].prompt).toContain("A-1");
      expect(ctx.calls[0].prompt).not.toContain("OLD-1");
      expect(ctx.calls[0].args.join(" ")).not.toContain("/elsewhere/old");
    });

    it("does not lose a feature with no coordinator, whose only material is its tickets' handoffs", async () => {
      const ctx = epicSetup();
      ctx.addTicket("A-1");
      ctx.ticketHandoff("A-1", 20);
      const svc = new FeatureService({ features: ctx.features, tickets: ctx.tickets, now: () => 60_000, refreshBeforeArchive: (ids) => ctx.runner.refreshBeforeArchive(ids) });
      await archiveDuringChildren({ ...ctx, svc });
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.featureHandoffs.latest(ctx.featureId)).not.toBeNull();
      expect(ctx.logs.join("\n")).not.toContain("nothing_to_summarize");
    });
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
    setRespond(async () => ({ ok: false, reason: "rate_limited", message: "429", result: null }));
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
