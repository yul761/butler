import { describe, expect, it, vi } from "vitest";
import { INTAKE_POLICY_DEFAULTS, type IncomingTicket, type IntakePolicy } from "../../shared/intake";
import { defaultPrPolicy } from "../../shared/pr-policy";
import type { BgJobContext, BgJobResult } from "../background/queue";
import { IntakeRepo } from "../db/intake-repo";
import { memDb } from "../test-utils";
import type { ModelClassification } from "./model";
import { IntakeService, type IntakeDeps } from "./intake-service";
import { parseRepoMap } from "./repo-map";
import type { IntakeSource } from "./sources";

const AC = "Acceptance criteria:\n- [ ] the button is blue\n- [ ] the label reads Save";
const ticket = (key: string, o: Partial<IncomingTicket> = {}): IncomingTicket => ({
  key, title: `Ticket ${key}`, description: `Change docs/${key.toLowerCase()}.md wording for clarity on save.\n${AC}`, type: "Story", labels: [],
  priority: null, url: `https://tracker.example/${key}`, storyPoints: 1, components: [], subtasks: [], repo: null, ...o,
});

interface Opts {
  policy?: Partial<IntakePolicy>;
  enabled?: boolean;
  model?: ModelClassification | null;
  allowed?: Partial<Record<"intake_tracker_comment" | "intake_tracker_status", boolean>>;
  coordinator?: boolean;
  preReview?: boolean;
  cost?: boolean;
  room?: boolean;
  openFails?: number;
  map?: string;
}

function setup(o: Opts = {}) {
  const db = memDb();
  const repo = new IntakeRepo(db);
  let now = 1_000_000;
  const policy: IntakePolicy = { ...INTAKE_POLICY_DEFAULTS, enabled: o.enabled ?? true, ...o.policy };
  const events: { kind: string; ticketKey: string | null; data: Record<string, unknown> | null; at: number }[] = [];
  const queue: string[] = [];
  const terms = new Map<string, number>();
  const tickets = new Map<string, { repoId: number; branch: string }>();
  const created: { key: string; startPoint: string | null }[] = [];
  const opened: { key: string; model: string | null }[] = [];
  const submitted: { termId: string; text: string }[] = [];
  const external: { kind: string; outcome: string }[] = [];
  const stacked: { parentBranch: string; branch: string }[] = [];
  const prs = new Set<string>();
  const changed = new Map<string, string[]>();
  const coordinatorTexts: string[] = [];
  let tickets0: IncomingTicket[] = [];
  let openFails = o.openFails ?? 0;
  const fetch = vi.fn(async () => ({ ok: true as const, tickets: tickets0 }));
  const source: IntakeSource = { kind: "file", fetch };
  const wake = vi.fn();
  const flags = { cost: o.cost ?? true, room: o.room ?? true, preReview: o.preReview ?? true, enabled: o.enabled ?? true };

  const d: IntakeDeps = {
    repo,
    policies: { forSlug: () => policy, anyEnabled: () => flags.enabled },
    sourceKind: () => "file",
    source: () => source,
    repoMap: () => parseRepoMap(o.map ?? "* => /work/web").rules,
    slugOf: async () => "acme/web",
    riskPolicy: () => defaultPrPolicy().risk,
    validKey: (k) => /^[A-Z][A-Z0-9]*-\d+$/.test(k),
    ticketExists: (k) => tickets.has(k) || k === "OLD-1",
    classifyModel: async () => (o.model === undefined ? { size: "medium", risk: "low", confidence: 0.9, reasons: ["looks medium"], expectedPaths: [], model: "m" } : o.model),
    lang: () => "en",
    preReviewOn: () => flags.preReview,
    gateOpen: () => true,
    enqueue: (k) => void queue.push(k),
    costAllows: () => flags.cost,
    openTerminals: (k) => terms.get(k) ?? 0,
    activeInRepo: async () =>
      repo.byState(["started"]).filter((r) => (terms.get(r.key) ?? 0) > 0).map((r) => ({ key: r.key, paths: changed.get(r.key) ?? [] })),
    sessionModel: (tier) => ({ ok: true, model: `model-${tier}` }),
    createTicket: async (i) => {
      const t = { repoId: tickets.size + 1, branch: `feature/${i.key}` };
      tickets.set(i.key, t);
      created.push({ key: i.key, startPoint: i.startPoint });
      return { ok: true, ...t };
    },
    ticketRepo: (k) => tickets.get(k) ?? null,
    openSession: async (k, _repoId, model) => {
      if (openFails > 0) {
        openFails--;
        return { ok: false, message: "spawn failed" };
      }
      opened.push({ key: k, model });
      terms.set(k, 1);
      return { ok: true, termId: `term-${k}` };
    },
    submit: (termId, text) => void submitted.push({ termId, text }),
    stack: {
      canStackOn: () => ({ ok: true }),
      stackOn: async (p) => {
        stacked.push({ parentBranch: p.parentBranch, branch: p.branch });
        return { ok: true };
      },
    },
    hasPr: (k) => prs.has(k),
    prOf: () => null,
    external: {
      allowed: (kind) => o.allowed?.[kind] ?? false,
      record: (kind, r) => void external.push({ kind, outcome: r.outcome }),
    },
    toCoordinator: async (text) => {
      coordinatorTexts.push(text);
      return o.coordinator ?? false;
    },
    recordEvent: (kind, refs = {}) => {
      events.push({ kind, ticketKey: refs.ticketKey ?? null, data: refs.data ?? null, at: now });
      return true;
    },
    metricEvents: (since, kinds) => events.filter((e) => e.at >= since && kinds.includes(e.kind)),
    knownRepos: () => [{ path: "/work/web", slug: "acme/web" }],
    now: () => now,
  };
  const s = new IntakeService(d);

  const ctx = (key: string, room = flags.room): BgJobContext & { openedCalls: number } => {
    const c = {
      id: 1, kind: "intake" as const, payload: { key }, checkpoint: null, ticketKey: key, attempts: 0, signal: new AbortController().signal,
      save: () => {}, sessionAwake: () => true, openedCalls: 0,
      admitSession: async () => (room ? { ok: true as const, opened: () => void c.openedCalls++ } : { ok: false as const, reason: "low memory" }),
    };
    return c;
  };
  /** 把排队的都跑一遍（被延后的留在队里）。 */
  const drain = async (): Promise<Record<string, BgJobResult>> => {
    const out: Record<string, BgJobResult> = {};
    const keys = [...new Set(queue.splice(0))];
    for (const k of keys) {
      const r = await s.handle(ctx(k));
      out[k] = r;
      if ("defer" in r) queue.push(k);
    }
    return out;
  };
  const state = (k: string) => repo.get(k)?.state;
  const kinds = () => events.map((e) => e.kind);

  return {
    s, repo, d, events, kinds, queue, terms, tickets, created, opened, submitted, external, stacked, prs, changed, coordinatorTexts, fetch, wake, flags, drain, ctx, state,
    setTickets: (t: IncomingTicket[]) => void (tickets0 = t),
    tick: (ms: number) => void (now += ms),
  };
}

describe("IntakeService: master switch", () => {
  it("off: never fetches and records nothing", async () => {
    const h = setup({ enabled: false });
    h.setTickets([ticket("PROJ-1")]);
    expect(h.s.active()).toBe(false);
    expect(await h.s.poll()).toEqual({ ok: false, message: "inactive" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.repo.list(10)).toEqual([]);
    expect(h.s.notices()).toEqual([]);
  });

  it("a ticket mapped to a repo whose policy is off is dropped", async () => {
    const h = setup({ enabled: true });
    h.d.policies.forSlug = () => ({ ...INTAKE_POLICY_DEFAULTS, enabled: false });
    h.setTickets([ticket("PROJ-1")]);
    expect(await h.s.poll()).toEqual({ ok: true, seen: 1 });
    expect(h.repo.list(10)).toEqual([]);
  });
});

describe("IntakeService: classify and start", () => {
  it("a small, low-risk, complete ticket auto-starts with the mapped tier", async () => {
    const h = setup({ policy: { tierSmall: "low" } });
    h.setTickets([ticket("PROJ-1")]);
    await h.s.poll();
    expect(h.state("PROJ-1")).toBe("queued");
    const c = h.repo.get("PROJ-1")!.classification;
    expect(c).toMatchObject({ size: "small", risk: "low", clarify: false, source: "rules", rulesVersion: 1 });
    expect(c.reasons.length).toBeGreaterThan(0);
    const r = await h.drain();
    expect(r["PROJ-1"]).toEqual({ done: true });
    expect(h.state("PROJ-1")).toBe("started");
    expect(h.opened).toEqual([{ key: "PROJ-1", model: "model-low" }]);
    expect(h.repo.get("PROJ-1")).toMatchObject({ tier: "low", model: "model-low", ticketKey: "PROJ-1" });
    expect(h.submitted[0]!.text).toContain("Work on ticket PROJ-1");
    expect(h.kinds()).toEqual(expect.arrayContaining(["intake.classified", "intake.queued", "intake.started"]));
    expect(h.kinds()).not.toContain("intake.decision");
    expect(h.events.find((e) => e.kind === "intake.started")!.data).toEqual({ mode: "auto", tier: "low" });
    expect(h.s.recent()[0]).toMatchObject({ key: "PROJ-1", what: "started" });
  });

  it("an already-known ticket is only recorded as existing", async () => {
    const h = setup();
    h.setTickets([ticket("OLD-1")]);
    await h.s.poll();
    expect(h.state("OLD-1")).toBe("exists");
    expect(h.s.view().items).toEqual([]);
    expect(h.queue).toEqual([]);
  });

  it("asks the model only for undecided dimensions; low confidence or failure needs a decision", async () => {
    const vague = ticket("PROJ-2", { storyPoints: null, description: `Rework how the cart totals are computed for discounts.\n${AC}` });
    const ok = setup();
    ok.setTickets([vague]);
    await ok.s.poll();
    expect(ok.repo.get("PROJ-2")!.classification).toMatchObject({ size: "medium", source: expect.stringMatching(/model|mixed/), confidence: 0.9 });
    expect(ok.state("PROJ-2")).toBe("queued");

    const unsure = setup({ model: { size: "medium", risk: "low", confidence: 0.3, reasons: [], expectedPaths: [], model: "m" } });
    unsure.setTickets([vague]);
    await unsure.s.poll();
    expect(unsure.state("PROJ-2")).toBe("needs_decision");
    expect(unsure.kinds()).toContain("intake.decision");

    const failed = setup({ model: null });
    failed.setTickets([vague]);
    await failed.s.poll();
    expect(failed.state("PROJ-2")).toBe("needs_decision");
  });

  it("hold reasons: auto-start off, too large, too risky, pre-review off; a manual start goes through", async () => {
    const off = setup({ policy: { autoStart: false } });
    off.setTickets([ticket("PROJ-1")]);
    await off.s.poll();
    expect(off.repo.get("PROJ-1")).toMatchObject({ state: "held", waitReason: "auto_off" });
    expect(off.kinds()).not.toContain("intake.decision");
    expect(await off.s.act({ key: "PROJ-1", op: "start" })).toEqual({ ok: true });
    await off.drain();
    expect(off.state("PROJ-1")).toBe("started");
    expect(off.events.find((e) => e.kind === "intake.started")!.data).toMatchObject({ mode: "manual" });

    const big = setup({ policy: { maxSize: "small" } });
    big.setTickets([ticket("PROJ-3", { storyPoints: 3 })]);
    await big.s.poll();
    expect(big.repo.get("PROJ-3")).toMatchObject({ state: "held", waitReason: "too_large" });

    const risky = setup({ policy: { maxRisk: "low" } });
    risky.setTickets([ticket("PROJ-4", { description: `Change db/migrations/0042_add.sql to add a column.\n${AC}` })]);
    await risky.s.poll();
    expect(risky.repo.get("PROJ-4")).toMatchObject({ state: "held", waitReason: "too_risky" });

    const noReview = setup({ preReview: false });
    noReview.setTickets([ticket("PROJ-5")]);
    await noReview.s.poll();
    expect(noReview.repo.get("PROJ-5")).toMatchObject({ state: "held", waitReason: "prereview_off" });
  });

  it("an unmapped ticket needs a repo; choosing one classifies it", async () => {
    const h = setup({ map: "" });
    h.setTickets([ticket("PROJ-1")]);
    await h.s.poll();
    expect(h.state("PROJ-1")).toBe("needs_repo");
    expect(h.s.notices()).toMatchObject([{ key: "PROJ-1", state: "needs_repo" }]);
    expect(await h.s.act({ key: "PROJ-1", op: "setRepo", repoPath: "/work/web" })).toEqual({ ok: true });
    expect(h.state("PROJ-1")).toBe("queued");
    expect(h.s.notices()).toEqual([]);
  });
});

describe("IntakeService: clarification", () => {
  const noAc = ticket("PROJ-7", { description: "Please make the save button blue so it stands out more on the settings screen." });

  it("missing acceptance criteria only alerts (notify mode, the default)", async () => {
    const h = setup();
    h.setTickets([noAc]);
    await h.s.poll();
    expect(h.repo.get("PROJ-7")).toMatchObject({ state: "needs_clarification", detail: "acceptance_criteria" });
    expect(h.repo.get("PROJ-7")!.classification.questions.length).toBe(1);
    expect(h.opened).toEqual([]);
    expect(h.queue).toEqual([]);
    expect(h.events.filter((e) => e.kind === "intake.decision")).toMatchObject([{ ticketKey: "PROJ-7", data: { state: "needs_clarification" } }]);
    expect(h.events.find((e) => e.kind === "intake.clarify")!.data).toEqual({ mode: "notify" });
    // 再拉一次（内容没变）：不重复提醒
    await h.s.poll();
    expect(h.events.filter((e) => e.kind === "intake.decision")).toHaveLength(1);
  });

  it("session mode opens a small session that asks on the tracker, when the switch is on", async () => {
    const h = setup({ policy: { clarifyMode: "session", tierSmall: "low" }, allowed: { intake_tracker_comment: true } });
    h.setTickets([noAc]);
    await h.s.poll();
    expect(h.opened).toEqual([{ key: "PROJ-7", model: "model-low" }]);
    expect(h.submitted[0]!.text).toMatch(/post these questions/);
    expect(h.external).toContainEqual({ kind: "intake_tracker_comment", outcome: "done" });
    expect(h.state("PROJ-7")).toBe("needs_clarification");
    expect(h.events.find((e) => e.kind === "intake.clarify")!.data).toEqual({ mode: "session" });
  });

  it("coordinator mode hands it to the coordinator; with no coordinator it falls back to notify", async () => {
    const h = setup({ policy: { clarifyMode: "coordinator" }, allowed: { intake_tracker_comment: true }, coordinator: true });
    h.setTickets([noAc]);
    await h.s.poll();
    expect(h.coordinatorTexts[0]).toContain("PROJ-7");
    expect(h.events.find((e) => e.kind === "intake.clarify")!.data).toEqual({ mode: "coordinator" });

    const none = setup({ policy: { clarifyMode: "coordinator" }, allowed: { intake_tracker_comment: true }, coordinator: false });
    none.setTickets([noAc]);
    await none.s.poll();
    expect(none.events.find((e) => e.kind === "intake.clarify")!.data).toEqual({ mode: "notify" });
  });

  it("with the outward switch off, session and coordinator modes only notify and record a skip", async () => {
    const h = setup({ policy: { clarifyMode: "session" } });
    h.setTickets([noAc]);
    await h.s.poll();
    expect(h.opened).toEqual([]);
    expect(h.external).toEqual([{ kind: "intake_tracker_comment", outcome: "skipped" }]);
    expect(h.events.find((e) => e.kind === "intake.clarify")!.data).toEqual({ mode: "notify" });
  });

  it("when the ticket is updated with the missing information it is reclassified and queued", async () => {
    const h = setup();
    h.setTickets([noAc]);
    await h.s.poll();
    h.setTickets([{ ...noAc, description: `${noAc.description}\n${AC}` }]);
    await h.s.poll();
    expect(h.state("PROJ-7")).toBe("queued");
  });
});

describe("IntakeService: start conditions", () => {
  it("over the parallel cap it waits, and starts when a slot frees", async () => {
    const h = setup({ policy: { maxParallel: 1 } });
    h.setTickets([ticket("PROJ-1"), ticket("PROJ-2")]);
    await h.s.poll();
    const r = await h.drain();
    expect(r["PROJ-1"]).toEqual({ done: true });
    expect(r["PROJ-2"]).toMatchObject({ defer: true, reason: "parallel" });
    expect(h.repo.get("PROJ-2")).toMatchObject({ state: "waiting", waitReason: "parallel" });
    expect(h.kinds()).not.toContain("intake.decision");
    h.terms.set("PROJ-1", 0);
    h.s.sessionEnded(h.wake);
    expect(h.wake).toHaveBeenCalled();
    await h.drain();
    expect(h.state("PROJ-2")).toBe("started");
  });

  it("two tickets touching the same path in one repo never start together", async () => {
    const shared = `Fix the rounding in src/cart/total.ts for discounts.\n${AC}`;
    const h = setup();
    h.setTickets([ticket("PROJ-1", { description: shared }), ticket("PROJ-2", { description: shared })]);
    await h.s.poll();
    const r = await h.drain();
    expect(r["PROJ-1"]).toEqual({ done: true });
    expect(r["PROJ-2"]).toMatchObject({ defer: true, reason: "conflict" });
    expect(h.repo.get("PROJ-2")!.detail).toContain("src/cart/total.ts");
    expect(h.events.filter((e) => e.kind === "intake.decision")).toMatchObject([{ ticketKey: "PROJ-2", data: { state: "waiting", reason: "conflict" } }]);
    expect(h.s.notices()).toMatchObject([{ key: "PROJ-2", reason: "conflict" }]);
    // 再试一次还是冲突：不重复提醒
    await h.drain();
    expect(h.events.filter((e) => e.kind === "intake.decision")).toHaveLength(1);
    expect(h.opened.map((x) => x.key)).toEqual(["PROJ-1"]);
    // 用户允许并行
    await h.s.act({ key: "PROJ-2", op: "allowParallel" });
    await h.drain();
    expect(h.state("PROJ-2")).toBe("started");
  });

  it("conflicts also come from files the running ticket has already changed", async () => {
    const h = setup();
    h.setTickets([ticket("PROJ-1")]);
    await h.s.poll();
    await h.drain();
    h.changed.set("PROJ-1", ["src/api/auth.ts"]);
    h.setTickets([ticket("PROJ-2", { description: `Tidy src/api/auth.ts error messages.\n${AC}` })]);
    await h.s.poll();
    expect((await h.drain())["PROJ-2"]).toMatchObject({ defer: true, reason: "conflict" });
  });

  it("conflictAction parallel starts anyway and notes the overlap", async () => {
    const shared = `Fix the rounding in src/cart/total.ts for discounts.\n${AC}`;
    const h = setup({ policy: { conflictAction: "parallel" } });
    h.setTickets([ticket("PROJ-1", { description: shared }), ticket("PROJ-2", { description: shared })]);
    await h.s.poll();
    await h.drain();
    expect(h.state("PROJ-2")).toBe("started");
    expect(h.repo.get("PROJ-2")!.detail).toContain("PROJ-1");
  });

  it("the cost breaker and memory admission defer", async () => {
    const h = setup({ cost: false });
    h.setTickets([ticket("PROJ-1")]);
    await h.s.poll();
    expect((await h.drain())["PROJ-1"]).toMatchObject({ defer: true, reason: "cost" });
    h.flags.cost = true;
    h.flags.room = false;
    expect((await h.drain())["PROJ-1"]).toMatchObject({ defer: true, reason: "memory" });
    expect(h.repo.get("PROJ-1")!.waitReason).toBe("memory");
    h.flags.room = true;
    const c = h.ctx("PROJ-1");
    expect(await h.s.handle(c)).toEqual({ done: true });
    expect(c.openedCalls).toBe(1);
  });

  it("a failing session retries, then fails and alerts", async () => {
    const h = setup({ openFails: 5 });
    h.setTickets([ticket("PROJ-1")]);
    await h.s.poll();
    expect((await h.drain())["PROJ-1"]).toMatchObject({ reason: "retry" });
    expect((await h.drain())["PROJ-1"]).toMatchObject({ reason: "retry" });
    expect((await h.drain())["PROJ-1"]).toEqual({ done: true });
    expect(h.repo.get("PROJ-1")).toMatchObject({ state: "failed", detail: "spawn failed" });
    expect(h.created).toHaveLength(1);
    expect(h.kinds()).toContain("intake.decision");
    // 再拉一次不会自己重试
    await h.s.poll();
    expect(h.queue).toEqual([]);
    expect(await h.s.act({ key: "PROJ-1", op: "retry" })).toEqual({ ok: true });
    expect(h.state("PROJ-1")).toBe("queued");
  });

  it("tracker status: asks the session to move the ticket only when the switch is on", async () => {
    const off = setup();
    off.setTickets([ticket("PROJ-1")]);
    await off.s.poll();
    await off.drain();
    expect(off.submitted[0]!.text).not.toMatch(/In Progress/);
    expect(off.external).toContainEqual({ kind: "intake_tracker_status", outcome: "skipped" });

    const on = setup({ allowed: { intake_tracker_status: true } });
    on.setTickets([ticket("PROJ-1")]);
    await on.s.poll();
    await on.drain();
    expect(on.submitted[0]!.text).toMatch(/In Progress/);
    expect(on.external).toContainEqual({ kind: "intake_tracker_status", outcome: "done" });
  });
});

describe("IntakeService: stacks", () => {
  const epic = ticket("PROJ-10", {
    storyPoints: 8, subtasks: [{ key: "PROJ-11", title: "Add the model" }, { key: "PROJ-12", title: "Add the screen" }],
  });

  it("a large ticket with subtasks splits into layers; the upper layer waits for the lower one's PR and stacks on it", async () => {
    const h = setup();
    h.setTickets([epic]);
    await h.s.poll();
    expect(h.state("PROJ-10")).toBe("split");
    expect(h.repo.children("PROJ-10").map((c) => [c.key, c.layer, c.state])).toEqual([["PROJ-11", 1, "queued"], ["PROJ-12", 2, "queued"]]);
    const r = await h.drain();
    expect(r["PROJ-11"]).toEqual({ done: true });
    expect(r["PROJ-12"]).toMatchObject({ defer: true, reason: "stack" });
    h.prs.add("PROJ-11");
    await h.drain();
    expect(h.state("PROJ-12")).toBe("started");
    expect(h.created.find((c) => c.key === "PROJ-12")!.startPoint).toBe("feature/PROJ-11");
    expect(h.stacked).toEqual([{ parentBranch: "feature/PROJ-11", branch: "feature/PROJ-12" }]);
  });

  it("stackSubtasks off: the large ticket is queued as one", async () => {
    const h = setup({ policy: { stackSubtasks: false } });
    h.setTickets([epic]);
    await h.s.poll();
    expect(h.state("PROJ-10")).toBe("queued");
    expect(h.repo.get("PROJ-10")!.tier).toBe("high");
  });
});

describe("IntakeService: classification edits and the Effect card", () => {
  it("records each changed dimension, keeps it across refetches and re-decides", async () => {
    const h = setup({ policy: { maxSize: "medium" } });
    h.setTickets([ticket("PROJ-1")]);
    await h.s.poll();
    expect(await h.s.editClassification({ key: "PROJ-1", size: "large", risk: "low" })).toEqual({ ok: true });
    expect(h.repo.get("PROJ-1")).toMatchObject({ state: "held", waitReason: "too_large", userDims: ["size"] });
    expect(h.repo.overrides(0)).toMatchObject([{ itemKey: "PROJ-1", dim: "size", from: "small", to: "large", rulesVersion: 1, classSource: "rules" }]);
    expect(h.events.find((e) => e.kind === "intake.overridden")!.data).toMatchObject({ via: "size" });
    // 内容变了重新分类：用户改的大小留着
    h.setTickets([{ ...ticket("PROJ-1"), title: "Changed title" }]);
    await h.s.poll();
    expect(h.repo.get("PROJ-1")!.classification.size).toBe("large");

    h.setTickets([ticket("PROJ-2")]);
    await h.s.poll();
    const e = h.s.effect(7);
    expect(e).toMatchObject({ classified: 2, overriddenItems: 1, overrideRate: 0.5, autoStarted: 0 });
    expect(e.byDim).toEqual([{ dim: "size", n: 1 }, { dim: "risk", n: 0 }, { dim: "clarify", n: 0 }]);
  });

  it("an edit after the session started is refused", async () => {
    const h = setup();
    h.setTickets([ticket("PROJ-1")]);
    await h.s.poll();
    await h.drain();
    expect(await h.s.editClassification({ key: "PROJ-1", size: "large" })).toEqual({ ok: false, message: "already" });
    expect(h.s.effect(7)).toMatchObject({ autoStarted: 1, overrideRate: 0 });
  });

  it("skip removes it from the notices", async () => {
    const h = setup({ map: "" });
    h.setTickets([ticket("PROJ-1")]);
    await h.s.poll();
    await h.s.act({ key: "PROJ-1", op: "skip" });
    expect(h.s.notices()).toEqual([]);
    await h.s.poll();
    expect(h.state("PROJ-1")).toBe("skipped");
  });
});
