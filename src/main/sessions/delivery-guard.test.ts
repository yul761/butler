import { describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { Session } from "../../shared/types";
import { DeliveryGuard, USER_TYPING_QUIET_MS, type DeliveryGuardDeps } from "./delivery-guard";
import { IdleEvidence } from "./idle-evidence";

const session = (o: Partial<Session> = {}): Session => ({
  id: "s-head", ticketKey: "DMS-1", cwd: "/r/app", origin: "shipherd", gitBranch: "dms-1", firstPrompt: null, lastActivityAt: null,
  waitingForInput: true, replacedBy: null, dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null,
  featureId: null, fixesSession: null, model: null, shipherd: false, lessonRunId: null, ...o,
});
const activity = (kind: SessionActivity["kind"], background = false): SessionActivity => ({
  sessionId: "s-head", kind, detail: null, background, startedAt: null, lastOutputAt: null, stuck: null, reason: null, action: null, lastOutput: [],
});

/** 一切都安静：s-old 是链上的旧 id，它的终端 t-1 跑着 head s-head，停着等输入。 */
function setup() {
  const state = {
    now: 1_000_000,
    term: "t-1" as string | null,
    head: session() as Session | null,
    activity: activity("waiting") as SessionActivity | null,
    screen: false,
    typedAt: 0,
    draft: false,
    inFlight: false,
    needsYou: undefined as ((headId: string) => boolean) | undefined,
    refreshing: undefined as ((headId: string) => boolean) | undefined,
  };
  const deps = (): DeliveryGuardDeps => ({
    termOf: () => state.term,
    head: () => state.head,
    activity: (id) => (id === state.head?.id ? state.activity : null),
    pty: {
      lastUserInputAt: () => state.typedAt,
      screenNeedsUser: () => state.screen,
      hasDraft: () => state.draft,
      autoInputInFlight: () => state.inFlight,
    },
    needsYou: state.needsYou,
    refreshing: state.refreshing,
    now: () => state.now,
  });
  const check = () => new DeliveryGuard(deps()).check("s-old");
  return { state, check, deps, guard: () => new DeliveryGuard(deps()) };
}

describe("DeliveryGuard", () => {
  it("blocks when no terminal runs the session", () => {
    const t = setup();
    t.state.term = null;
    expect(t.check()).toEqual({ ok: false, block: "closed" });
  });

  it("wakes a hibernated session and reports it as hibernated (WS-M B)", () => {
    const t = setup();
    t.state.term = null;
    const woken: string[] = [];
    const g = new DeliveryGuard({ ...t.deps(), wakeIfHibernated: (id) => (woken.push(id), true) });
    expect(g.check("s-old")).toEqual({ ok: false, block: "hibernated" });
    expect(woken).toEqual(["s-old"]);
    t.state.term = "t-1";
    expect(new DeliveryGuard({ ...t.deps(), wakeIfHibernated: (id) => (woken.push(id), true) }).check("s-old").ok).toBe(true);
    expect(woken).toHaveLength(1);
  });

  it("blocks a cost-paused session before anything else and does not wake it (workstream L)", () => {
    const t = setup();
    t.state.term = null;
    const woken: string[] = [];
    const g = new DeliveryGuard({ ...t.deps(), wakeIfHibernated: (id) => (woken.push(id), true), costPaused: (id) => id === "s-old" });
    expect(g.check("s-old")).toEqual({ ok: false, block: "cost_paused" });
    expect(woken).toEqual([]);
  });

  it("blocks on a draft even after the quiet period", () => {
    const t = setup();
    t.state.typedAt = t.state.now - 10 * USER_TYPING_QUIET_MS;
    t.state.draft = true;
    expect(t.check()).toEqual({ ok: false, block: "draft" });
  });

  it("blocks while the user typed in the last 30 seconds", () => {
    expect(USER_TYPING_QUIET_MS).toBe(30_000);
    const t = setup();
    t.state.typedAt = t.state.now - USER_TYPING_QUIET_MS + 1;
    expect(t.check()).toEqual({ ok: false, block: "typing" });
    t.state.typedAt = t.state.now - USER_TYPING_QUIET_MS;
    expect(t.check()).toMatchObject({ ok: true });
  });

  it("uses typingQuietMs in place of the default quiet period", () => {
    const t = setup();
    t.state.typedAt = t.state.now - 1000;
    const guard = (typingQuietMs: number) =>
      new DeliveryGuard({
        termOf: () => "t-1", head: () => session(), activity: () => activity("idle"),
        pty: { lastUserInputAt: () => t.state.typedAt, screenNeedsUser: () => false, hasDraft: () => false, autoInputInFlight: () => false },
        typingQuietMs, now: () => t.state.now,
      });
    expect(guard(1000).check("s-old")).toMatchObject({ ok: true });
    expect(guard(1001).check("s-old")).toEqual({ ok: false, block: "typing" });
  });

  it("blocks while a permission prompt is on screen", () => {
    const t = setup();
    t.state.screen = true;
    expect(t.check()).toEqual({ ok: false, block: "screen" });
  });

  it("blocks when the session is busy or its activity is unknown", () => {
    const t = setup();
    t.state.head = session({ waitingForInput: false });
    expect(t.check()).toEqual({ ok: false, block: "busy", busy: "turn" });
    t.state.head = session();
    for (const kind of ["thinking", "edit", "command", "approval"] as const) {
      t.state.activity = activity(kind);
      expect(t.check()).toEqual({ ok: false, block: "busy", busy: "turn" });
    }
    t.state.activity = null;
    expect(t.check()).toEqual({ ok: false, block: "busy", busy: "turn" });
    t.state.activity = activity("waiting");
    t.state.head = null;
    expect(t.check()).toEqual({ ok: false, block: "busy", busy: "turn" });
  });

  it("counts a session waiting for input with only a background task running as quiet", () => {
    const t = setup();
    t.state.activity = activity("push", true);
    expect(t.check()).toEqual({ ok: true, termId: "t-1", headId: "s-head" });
    // 后台任务在跑、但这一轮还没结束：仍然是忙。
    t.state.head = session({ waitingForInput: false });
    expect(t.check()).toEqual({ ok: false, block: "busy", busy: "turn" });
  });

  it("blocks when needsYou says so", () => {
    const t = setup();
    const asked: string[] = [];
    t.state.needsYou = (id) => (asked.push(id), true);
    expect(t.check()).toEqual({ ok: false, block: "needs_you" });
    expect(asked).toEqual(["s-head"]);
  });

  it("refreshing sessions are busy for every delivery (plan 16)", () => {
    const t = setup();
    const asked: string[] = [];
    t.state.refreshing = (id) => (asked.push(id), true);
    expect(t.check()).toEqual({ ok: false, block: "busy", busy: "refreshing" });
    expect(asked).toEqual(["s-head"]);
    t.state.refreshing = () => false;
    expect(t.check()).toMatchObject({ ok: true });
  });

  it("is busy while another automatic input is in flight on the terminal (I2)", () => {
    const t = setup();
    t.state.inFlight = true;
    expect(t.check()).toEqual({ ok: false, block: "busy", busy: "auto_input" });
  });

  describe("recheckAfter (I2: the last look right before the paste)", () => {
    it("passes while the guard still passes on the same terminal and the user has not typed since", () => {
      const t = setup();
      const g = t.guard();
      const passed = g.check("s-old");
      expect(passed.ok).toBe(true);
      const recheck = g.recheckAfter("s-old", passed as { termId: string });
      expect(recheck()).toBe(true);
    });

    it("fails when the user typed anything after the check, even outside the typing window", () => {
      const t = setup();
      const g = new DeliveryGuard({ ...t.deps(), typingQuietMs: 1 });
      const recheck = g.recheckAfter("s-old", { termId: "t-1" });
      t.state.now += 10;
      t.state.typedAt = t.state.now - 5; // 打字窗口 1 ms 早过了，但这是 check 之后的输入
      expect(recheck()).toBe(false);
    });

    it("fails when the guard no longer passes or the session moved to another terminal", () => {
      const t = setup();
      const g = t.guard();
      const recheck = g.recheckAfter("s-old", { termId: "t-1" });
      t.state.head = session({ waitingForInput: false });
      expect(recheck()).toBe(false);
      t.state.head = session();
      t.state.term = "t-2";
      expect(recheck()).toBe(false);
      t.state.term = "t-1";
      t.state.inFlight = true;
      expect(recheck()).toBe(false);
    });
  });

  it("passes and returns the terminal when everything is quiet", () => {
    const t = setup();
    expect(t.check()).toEqual({ ok: true, termId: "t-1", headId: "s-head" });
    t.state.activity = activity("idle");
    t.state.needsYou = () => false;
    expect(t.check()).toEqual({ ok: true, termId: "t-1", headId: "s-head" });
  });
});

describe("DeliveryGuard: the record says working, the screen says stopped (BTL-269 B)", () => {
  const RULE = "─".repeat(120);
  const idleScreen = ["⏺ 做完了。", "", RULE, "❯ ", RULE, "  ? for shortcuts"];
  function stuck() {
    const t = setup();
    t.state.head = session({ waitingForInput: false });
    t.state.activity = activity("thinking");
    const screen = { lines: idleScreen, outAt: t.state.now - 1000, grewAt: t.state.now - 1000 as number | null };
    const healed: string[] = [];
    const evidence = new IdleEvidence({ screen: () => screen.lines, lastOutputAt: () => screen.outAt, transcriptGrewAt: () => screen.grewAt, now: () => t.state.now });
    // 校正记录：和真的一样把 waitingForInput 改成 true（活动还是「在想」）。
    const heal = (h: string) => {
      healed.push(h);
      t.state.head = { ...t.state.head!, waitingForInput: true };
    };
    const guard = new DeliveryGuard({ ...t.deps(), refreshing: (h) => t.state.refreshing?.(h) ?? false, idle: (h, term) => evidence.check(h, term), healed: heal });
    return { t, screen, healed, guard };
  }

  it("lets it in once the screen shows an empty box, nothing running, and output and transcript are quiet for 45 s; heals the record", () => {
    const { t, screen, healed, guard } = stuck();
    expect(guard.check("s-old")).toEqual({ ok: false, block: "busy", busy: "unsure" });
    expect(healed).toEqual([]);
    t.state.now += 45_000;
    // 先校正记录、这一次不送：按停下处理，先判断一次「需要你」。
    expect(guard.check("s-old")).toEqual({ ok: false, block: "busy", busy: "unsure" });
    expect(healed).toEqual(["s-head"]);
    expect(guard.check("s-old")).toEqual({ ok: true, termId: "t-1", headId: "s-head" });
    expect(healed).toEqual(["s-head"]);
    // transcript 还在长：不放行。
    screen.grewAt = t.state.now - 1000;
    expect(guard.check("s-old")).toEqual({ ok: false, block: "busy", busy: "unsure" });
  });

  it("each of the four pieces of evidence is needed", () => {
    for (const bad of ["box", "spinner", "permission", "output"] as const) {
      const { t, screen, guard } = stuck();
      t.state.now += 60_000;
      if (bad === "box") screen.lines = [RULE, "❯ 打了一半", RULE];
      if (bad === "spinner") screen.lines = ["✻ Thinking… (12s · esc to interrupt)", ...idleScreen];
      if (bad === "permission") screen.lines = [RULE, " Bash command", " Do you want to proceed?", " ❯ 1. Yes", "   2. No"];
      if (bad === "output") screen.outAt = t.state.now - 1000;
      const r = guard.check("s-old");
      expect(r.ok, bad).toBe(false);
      if (bad === "spinner") expect(r).toMatchObject({ busy: "turn" });
    }
  });

  it("a status line that keeps redrawing does not hide a stable screen: content above the box unchanged for 45 s counts as quiet", () => {
    const { t, screen, guard } = stuck();
    screen.outAt = t.state.now;
    expect(guard.check("s-old").ok).toBe(false);
    t.state.now += 46_000;
    screen.outAt = t.state.now; // 状态栏刚刷新过
    screen.lines = [...idleScreen.slice(0, -1), "  ctx 41%"];
    expect(guard.check("s-old")).toMatchObject({ ok: false, busy: "unsure" }); // 校正这一次
    expect(guard.check("s-old").ok).toBe(true);
  });

  it("does not heal the record when another check blocks (a refresh), so a session being refreshed is not treated as stopped", () => {
    const { t, healed, guard } = stuck();
    t.state.now += 45_000;
    t.state.refreshing = () => true;
    expect(guard.check("s-old")).toMatchObject({ ok: false, busy: "refreshing" });
    expect(healed).toEqual([]);
  });

  it("force (the Deliver now button) still stops when the screen shows it working: the hook gets it in at its next tool call", () => {
    const { screen, guard } = stuck();
    screen.lines = ["✻ Thinking… (12s · esc to interrupt)", ...idleScreen];
    expect(guard.check("s-old", { force: true })).toEqual({ ok: false, block: "busy", busy: "turn" });
    // 看着停了、还没安静够久：送。
    screen.lines = idleScreen;
    expect(guard.check("s-old", { force: true })).toMatchObject({ ok: true });
  });

  it("force (the Deliver now button) skips unsure, needs-you and typing, but not a draft, a prompt on screen or a refresh", () => {
    const t = setup();
    t.state.head = session({ waitingForInput: false });
    t.state.needsYou = () => true;
    t.state.typedAt = t.state.now - 1000;
    const g = () => new DeliveryGuard({ ...t.deps(), idle: () => ({ idle: false, working: false, looksIdle: true }) });
    expect(g().check("s-old", { force: true })).toMatchObject({ ok: true });
    t.state.draft = true;
    expect(g().check("s-old", { force: true })).toEqual({ ok: false, block: "draft" });
    t.state.draft = false;
    t.state.screen = true;
    expect(g().check("s-old", { force: true })).toEqual({ ok: false, block: "screen" });
    t.state.screen = false;
    t.state.refreshing = () => true;
    expect(g().check("s-old", { force: true })).toMatchObject({ ok: false, busy: "refreshing" });
  });
});
