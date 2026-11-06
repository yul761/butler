import { describe, expect, it } from "vitest";
import type { SessionActivity } from "../../shared/activity";
import type { Session } from "../../shared/types";
import { DeliveryGuard, USER_TYPING_QUIET_MS, type DeliveryGuardDeps } from "./delivery-guard";

const session = (o: Partial<Session> = {}): Session => ({
  id: "s-head", ticketKey: "DMS-1", cwd: "/r/app", origin: "butler", gitBranch: "dms-1", firstPrompt: null, lastActivityAt: null,
  waitingForInput: true, replacedBy: null, dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null,
  featureId: null, fixesSession: null, epicId: null, model: null, ...o,
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
    needsYou: undefined as ((headId: string) => boolean) | undefined,
  };
  const deps = (): DeliveryGuardDeps => ({
    termOf: () => state.term,
    head: () => state.head,
    activity: (id) => (id === state.head?.id ? state.activity : null),
    pty: {
      lastUserInputAt: () => state.typedAt,
      screenNeedsUser: () => state.screen,
      hasDraft: () => state.draft,
    },
    needsYou: state.needsYou,
    now: () => state.now,
  });
  const check = () => new DeliveryGuard(deps()).check("s-old");
  return { state, check };
}

describe("DeliveryGuard", () => {
  it("blocks when no terminal runs the session", () => {
    const t = setup();
    t.state.term = null;
    expect(t.check()).toEqual({ ok: false, block: "closed" });
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
        pty: { lastUserInputAt: () => t.state.typedAt, screenNeedsUser: () => false, hasDraft: () => false },
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
    expect(t.check()).toEqual({ ok: false, block: "busy" });
    t.state.head = session();
    for (const kind of ["thinking", "edit", "command", "approval"] as const) {
      t.state.activity = activity(kind);
      expect(t.check()).toEqual({ ok: false, block: "busy" });
    }
    t.state.activity = null;
    expect(t.check()).toEqual({ ok: false, block: "busy" });
    t.state.activity = activity("waiting");
    t.state.head = null;
    expect(t.check()).toEqual({ ok: false, block: "busy" });
  });

  it("counts a session waiting for input with only a background task running as quiet", () => {
    const t = setup();
    t.state.activity = activity("push", true);
    expect(t.check()).toEqual({ ok: true, termId: "t-1", headId: "s-head" });
    // 后台任务在跑、但这一轮还没结束：仍然是忙。
    t.state.head = session({ waitingForInput: false });
    expect(t.check()).toEqual({ ok: false, block: "busy" });
  });

  it("blocks when needsYou says so", () => {
    const t = setup();
    const asked: string[] = [];
    t.state.needsYou = (id) => (asked.push(id), true);
    expect(t.check()).toEqual({ ok: false, block: "needs_you" });
    expect(asked).toEqual(["s-head"]);
  });

  it("passes and returns the terminal when everything is quiet", () => {
    const t = setup();
    expect(t.check()).toEqual({ ok: true, termId: "t-1", headId: "s-head" });
    t.state.activity = activity("idle");
    t.state.needsYou = () => false;
    expect(t.check()).toEqual({ ok: true, termId: "t-1", headId: "s-head" });
  });
});
