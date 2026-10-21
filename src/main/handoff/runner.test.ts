import { describe, expect, it } from "vitest";
import type { Handoff } from "../../shared/handoff";
import type { Ticket } from "../../shared/types";
import { headlessArgs, READ_ONLY_TOOLS, runHeadless, unsafeCmdArg, type HeadlessOutcome, type HeadlessRequest, type HeadlessRun } from "../claude/headless";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb, tempDir, writeFakeClaude } from "../test-utils";
import { ingestHandoff, type IngestInput } from "./ingest";
import { HandoffRunner } from "./runner";
import { emptyHandoff, HANDOFF_JSON_SCHEMA, REFRESH_JSON_SCHEMA } from "./schema";

const NOW = 50_000;

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => ({
  key, title: `标题 ${key}`, repoPath: "/r", workMode: "worktree", worktreePath: `/w/${key}`, branch: `feature/${key}`,
  status: "active", statusManual: null, createdAt: 1, archivedAt: null, ...over,
});

const valid = (over: Partial<Handoff> = {}): Handoff => ({ ...emptyHandoff("X"), next_steps: ["写测试"], ...over });

const ok = (structured: unknown, sessionId = "fork-1"): HeadlessOutcome => ({
  ok: true,
  result: { sessionId, isError: false, subtype: "success", resultText: JSON.stringify(structured), structured, permissionDenials: [], apiErrorStatus: null, costUsd: 0 },
});

function setup(opts: { run?: HeadlessRun; signal?: AbortSignal } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const settings = new SettingsRepo(db);
  const mtimes: Record<string, number> = {};
  const calls: HeadlessRequest[] = [];
  let respond: (req: HeadlessRequest, n: number) => Promise<HeadlessOutcome> = async () => ok(valid());
  const run: HeadlessRun =
    opts.run ??
    ((req) => {
      calls.push(req);
      return respond(req, calls.length);
    });
  let fid = 0;
  const ingest = (input: IngestInput) => ingestHandoff({ db, tickets, handoffs, followups, now: () => NOW, newFollowupId: () => `f${++fid}` }, input);
  const runner = new HandoffRunner({
    tickets, sessions, handoffs, followups, settings, ingest,
    workDir: (t) => t.worktreePath ?? t.repoPath,
    run,
    ready: async () => undefined,
    claude: () => ({ path: "/bin/claude", pathValue: "/login/bin" }),
    baseEnv: { HOME: "/h" },
    transcriptMtime: (id) => mtimes[id] ?? null,
    now: () => NOW,
    newRunId: () => "run-1",
    signal: opts.signal,
  });
  /** 一个有对话记录的 ticket：session 是 s-<key>，transcript 在 mtime 时刻修改过（null 表示没有 transcript）。 */
  const addTicket = (key: string, mtime: number | null = NOW - 10) => {
    tickets.insert(ticket(key));
    sessions.insertIfAbsent({ id: `s-${key}`, ticketKey: key, cwd: `/w/${key}`, origin: "butler", lastActivityAt: 1, createdAt: 1 });
    if (mtime !== null) mtimes[`s-${key}`] = mtime;
  };
  const setRespond = (fn: typeof respond) => {
    respond = fn;
  };
  return { runner, tickets, sessions, handoffs, settings, calls, addTicket, ingest, setRespond };
}

describe("HandoffRunner", () => {
  it("picks tickets whose transcript changed after the last captured handoff", () => {
    const { runner, addTicket, ingest } = setup();
    addTicket("A-1", NOW - 10);
    addTicket("B-2", 100);
    addTicket("C-3", null);
    ingest({ ticketKey: "B-2", sessionId: "s-B-2", trigger: "nightly", payload: valid(), rawText: null });
    expect(runner.candidates()).toEqual(["A-1"]);
  });

  it("runs a read-only, non-persistent fork with the prompt on stdin and stores the handoff", async () => {
    const { runner, addTicket, calls, sessions, handoffs, ingest, settings } = setup();
    addTicket("A-1", NOW + 10);
    settings.set("trackerTools", "mcp__jira__get_issue");
    ingest({
      ticketKey: "A-1", sessionId: "s-A-1", trigger: "command", rawText: null,
      payload: valid({ next_steps: ["上一次的下一步"], followups: [{ id: null, kind: "config", description: "改配置", trigger: "after_merge", due_date: null, done: false }] }),
    });
    const batch = await runner.runNightly();
    expect(batch).toMatchObject({ status: "ok", outcomes: [{ ticketKey: "A-1", status: "stored", degraded: false }] });
    const [req] = calls;
    expect(req.claudePath).toBe("/bin/claude");
    expect(req.cwd).toBe("/w/A-1");
    expect(req.args.slice(0, 11)).toEqual([
      "-p", "--output-format", "json", "--json-schema", HANDOFF_JSON_SCHEMA, "--no-session-persistence", "--permission-mode", "dontAsk",
      "--resume", "s-A-1", "--fork-session",
    ]);
    expect(req.args.slice(req.args.indexOf("--allowedTools") + 1)).toContain("mcp__jira__get_issue");
    expect(req.args.join(" ")).not.toContain("上一次的下一步");
    expect(req.prompt).toContain("A-1");
    expect(req.prompt).toContain("上一次的下一步");
    expect(req.prompt).toContain('"id": "f1"');
    expect(req.env).toMatchObject({ BUTLER_SESSION: "headless:run-1", PATH: "/login/bin" });
    expect(req.env.BUTLER_TICKET).toBeUndefined();
    expect(sessions.get("fork-1")).toMatchObject({ dismissed: true });
    expect(handoffs.latest("A-1")).toMatchObject({ trigger: "nightly", sessionId: "s-A-1", degraded: false });
  });

  it("retries once with the validation errors, then stores a valid handoff", async () => {
    const { runner, addTicket, calls, handoffs, setRespond } = setup();
    addTicket("A-1");
    setRespond(async (_req, n) => (n === 1 ? ok({ foo: 1 }) : ok(valid())));
    expect(await runner.runManual("A-1")).toMatchObject({ status: "stored", degraded: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain("上一次的输出没有通过校验");
    expect(calls[1].prompt).toContain("done_today");
    expect(handoffs.listByTicket("A-1")).toHaveLength(1);
  });

  it("stores a degraded handoff with the raw text when the retry is invalid too", async () => {
    const { runner, addTicket, calls, handoffs, tickets, setRespond } = setup();
    addTicket("A-1");
    setRespond(async () => ok({ foo: 1 }));
    expect(await runner.runManual("A-1")).toMatchObject({ status: "stored", degraded: true });
    expect(calls).toHaveLength(2);
    expect(handoffs.latest("A-1")).toMatchObject({ degraded: true, rawText: '{"foo":1}', trigger: "manual" });
    expect(tickets.get("A-1")?.status).toBe("active");
  });

  it("never runs more than two at once", async () => {
    let active = 0;
    let max = 0;
    const run: HeadlessRun = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return ok(valid());
    };
    const { runner, addTicket } = setup({ run });
    for (const k of ["A-1", "B-2", "C-3", "D-4", "E-5"]) addTicket(k);
    const batch = await runner.runNightly();
    expect(batch.outcomes.map((o) => o.status)).toEqual(["stored", "stored", "stored", "stored", "stored"]);
    expect(max).toBe(2);
  });

  it("stops starting new runs after a rate limit and reports the batch as partial", async () => {
    const { runner, addTicket, calls, setRespond } = setup();
    for (const k of ["A-1", "B-2", "C-3", "D-4"]) addTicket(k);
    setRespond(async () => ({ ok: false, reason: "rate_limited", message: "429", result: null }));
    const batch = await runner.runNightly();
    expect(batch.status).toBe("partial");
    expect(batch.outcomes.every((o) => o.status === "skipped" && o.reason === "rate_limited")).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("reports a timeout as failed and stores nothing", async () => {
    const { runner, addTicket, handoffs, setRespond } = setup();
    addTicket("A-1");
    setRespond(async () => ({ ok: false, reason: "timeout", message: "超过 300 秒没有完成", result: null }));
    expect(await runner.runManual("A-1")).toMatchObject({ status: "failed", reason: "timeout" });
    expect(handoffs.latest("A-1")).toBeNull();
  });

  it("manual runs without a session start fresh in the ticket workdir; the nightly batch skips them", async () => {
    const { runner, tickets, calls } = setup();
    tickets.insert(ticket("A-1"));
    expect(await runner.runManual("A-1")).toMatchObject({ status: "stored" });
    expect(calls[0].args).not.toContain("--resume");
    expect(calls[0].cwd).toBe("/w/A-1");
    expect((await runner.runNightly()).outcomes).toEqual([]);
  });

  it("leaves the resumed session undismissed when claude reports the resumed id", async () => {
    const { runner, addTicket, sessions, setRespond } = setup();
    addTicket("A-1", NOW + 10);
    setRespond(async () => ok(valid(), "s-A-1"));
    await runner.runNightly();
    expect(sessions.get("s-A-1")).toMatchObject({ dismissed: false, ticketKey: "A-1" });
    expect(sessions.listByTicket("A-1").find((s) => !s.dismissed)?.id).toBe("s-A-1");
  });

  it("refreshes in_review and merged tickets without resuming and keeps the rest of the last handoff", async () => {
    const { runner, addTicket, tickets, calls, handoffs, ingest, setRespond } = setup();
    addTicket("A-1");
    addTicket("B-2");
    ingest({
      ticketKey: "A-1", sessionId: "s-A-1", trigger: "nightly", rawText: null,
      payload: valid({
        pr: { number: 9, url: "u", state: "open", review: "pending" },
        done_today: ["做了 X"],
        next_steps: ["合并后改配置"],
        followups: [{ id: null, kind: "config", description: "改配置", trigger: "after_merge", due_date: null, done: false }],
      }),
    });
    expect(tickets.get("A-1")?.status).toBe("in_review");
    setRespond(async () => ok({ status: "merged_pending_followup", pr: { number: 9, url: "u", state: "merged", review: "approved" }, jira: null }));
    const batch = await runner.refreshForBrief();
    expect(batch.outcomes.map((o) => o.ticketKey)).toEqual(["A-1"]);
    expect(calls[0].args).not.toContain("--resume");
    expect(calls[0].args[calls[0].args.indexOf("--json-schema") + 1]).toBe(REFRESH_JSON_SCHEMA);
    expect(calls[0].cwd).toBe("/w/A-1");
    const latest = handoffs.latest("A-1")!;
    expect(latest).toMatchObject({ trigger: "refresh", sessionId: null });
    expect(latest.payload).toMatchObject({ done_today: [], next_steps: ["合并后改配置"], pr: { state: "merged" } });
    expect(tickets.get("A-1")?.status).toBe("merged_pending_followup");
  });

  it("shares one run when the same ticket is requested twice at once", async () => {
    const { runner, addTicket, calls } = setup();
    addTicket("A-1");
    const [a, b] = await Promise.all([runner.runManual("A-1"), runner.runManual("A-1")]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it("works end to end with runHeadless and a fake claude executable", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, `result(${JSON.stringify(valid({ done_today: ["真的跑了"] }))});`);
    const { runner, addTicket, handoffs } = setup({
      run: (req) => runHeadless({ ...req, claudePath: fake.path, cwd: dir, env: { ...req.env, PATH: process.env.PATH ?? "" } }),
    });
    addTicket("A-1");
    expect(await runner.runManual("A-1")).toMatchObject({ status: "stored", degraded: false });
    const [call] = fake.calls();
    expect(call.input).toContain("A-1");
    expect(call.args).toContain("--fork-session");
    expect(call.butlerSession).toBe("headless:run-1");
    expect(handoffs.latest("A-1")?.payload?.done_today).toEqual(["真的跑了"]);
  });

  it("passes the real schema and tool args through the win32 .cmd safety check", () => {
    const cmd = "C:\\npm\\claude.cmd";
    for (const schema of [HANDOFF_JSON_SCHEMA, REFRESH_JSON_SCHEMA]) {
      expect(unsafeCmdArg(headlessArgs({ schema, resumeSessionId: "s-1", allowedTools: [...READ_ONLY_TOOLS] }), cmd, "win32")).toBeNull();
    }
  });

  it("does not ingest or flag rate limiting when the run is aborted, and starts nothing afterwards", async () => {
    const ac = new AbortController();
    const { runner, addTicket, calls, handoffs, setRespond } = setup({ signal: ac.signal });
    for (const k of ["A-1", "B-2", "C-3", "D-4"]) addTicket(k);
    setRespond(async () => {
      ac.abort();
      return { ok: false, reason: "aborted", message: "已取消", result: null };
    });
    const batch = await runner.runNightly();
    expect(batch.status).toBe("partial");
    expect(batch.outcomes.some((o) => o.status === "skipped")).toBe(false);
    expect(batch.outcomes.every((o) => o.status === "failed" && o.reason === "aborted")).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(handoffs.latest("A-1")).toBeNull();
  });
});
