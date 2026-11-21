import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import {
  HIBERNATE_OPEN_QUIET_MS, HIBERNATE_WAKE_QUIET_MS, hibernateBlock, hibernateDue, hibernatableKind, PRESSURE_MIN_IDLE_MS, pressureVictim, underPressure, waitState,
  type HibernateCandidate,
} from "./hibernation";

const NOW = 10_000_000;

const session = (over: Partial<Session> = {}): Session => ({
  id: "h", ticketKey: "T-1", cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: "hi", lastActivityAt: 0, waitingForInput: true, replacedBy: null,
  dismissed: false, createdAt: 0, repoId: 1, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, model: null, butler: false,
  lessonRunId: null, ...over,
});

const cand = (over: Partial<HibernateCandidate> = {}): HibernateCandidate => ({
  head: session(), termId: "h", pinned: false, transcript: "present", activity: { working: false, background: false }, screenNeedsUser: false, draft: false,
  typing: false, autoInput: false, refreshing: false, visible: false, childrenWorking: false, openedAt: NOW - 3_600_000, wokeAt: 0, idleSince: NOW - 3_600_000,
  ...over,
});

describe("waitState", () => {
  it("you before ci before review before idle", () => {
    expect(waitState({ needsYou: true, ciPending: true, reviewPending: true })).toBe("you");
    expect(waitState({ needsYou: false, ciPending: true, reviewPending: true })).toBe("ci");
    expect(waitState({ needsYou: false, ciPending: false, reviewPending: true })).toBe("review");
    expect(waitState({ needsYou: false, ciPending: false, reviewPending: false })).toBe("idle");
  });
});

describe("hibernateBlock", () => {
  it("a stopped, unseen, resumable session can hibernate", () => {
    expect(hibernateBlock(cand(), NOW)).toBeNull();
  });

  const cases: [string, Partial<HibernateCandidate>, string][] = [
    ["pinned", { pinned: true }, "pinned"],
    ["not a Butler session", { head: session({ origin: "discovered" }) }, "kind"],
    ["a fix session", { head: session({ ticketKey: null, featureId: 1, fixesSession: "x" }) }, "kind"],
    ["a lesson run", { head: session({ ticketKey: null, lessonRunId: 3 }) }, "kind"],
    ["no transcript yet", { transcript: "absent" }, "transcript"],
    ["transcript unknown", { transcript: "unknown" }, "transcript"],
    ["activity unknown", { activity: null }, "working"],
    ["working", { activity: { working: true, background: false } }, "working"],
    ["a background shell", { activity: { working: false, background: true } }, "working"],
    ["a dialog on screen", { screenNeedsUser: true }, "screen"],
    ["a draft", { draft: true }, "draft"],
    ["the user is typing", { typing: true }, "typing"],
    ["auto input or a reservation", { autoInput: true }, "auto_input"],
    ["being refreshed or closed", { refreshing: true }, "refreshing"],
    ["visible", { visible: true }, "visible"],
    ["a coordinator whose children work", { childrenWorking: true }, "children"],
    ["opened under 2 minutes ago", { openedAt: NOW - HIBERNATE_OPEN_QUIET_MS + 1 }, "just_opened"],
    ["woken under 10 minutes ago", { wokeAt: NOW - HIBERNATE_WAKE_QUIET_MS + 1 }, "just_woken"],
  ];
  for (const [name, over, block] of cases) it(`never: ${name}`, () => expect(hibernateBlock(cand(over), NOW)).toBe(block));

  it("the quiet windows end", () => {
    expect(hibernateBlock(cand({ openedAt: NOW - HIBERNATE_OPEN_QUIET_MS }), NOW)).toBeNull();
    expect(hibernateBlock(cand({ wokeAt: NOW - HIBERNATE_WAKE_QUIET_MS }), NOW)).toBeNull();
  });
});

describe("hibernatableKind", () => {
  it("ticket, ticket coordinator, feature coordinator and Butler sessions", () => {
    expect(hibernatableKind(session())).toBe(true);
    expect(hibernatableKind(session({ coordinator: true }))).toBe(true);
    expect(hibernatableKind(session({ ticketKey: null, featureId: 2 }))).toBe(true);
    expect(hibernatableKind(session({ ticketKey: null, butler: true }))).toBe(true);
    expect(hibernatableKind(session({ ticketKey: null }))).toBe(false);
  });
});

describe("hibernateDue", () => {
  it("counts from idleSince; 0 minutes is never", () => {
    expect(hibernateDue(cand({ idleSince: NOW - 20 * 60_000 }), 20, NOW)).toBe(true);
    expect(hibernateDue(cand({ idleSince: NOW - 20 * 60_000 + 1 }), 20, NOW)).toBe(false);
    expect(hibernateDue(cand({ idleSince: 0 }), 0, NOW)).toBe(false);
  });
});

describe("pressure", () => {
  it("picks the longest idle candidate that passes every rule and has been idle 5 minutes", () => {
    const a = cand({ head: session({ id: "a" }), idleSince: NOW - 30 * 60_000 });
    const b = cand({ head: session({ id: "b" }), idleSince: NOW - 90 * 60_000, pinned: true });
    const c = cand({ head: session({ id: "c" }), idleSince: NOW - 60 * 60_000 });
    const d = cand({ head: session({ id: "d" }), idleSince: NOW - PRESSURE_MIN_IDLE_MS + 1 });
    expect(pressureVictim([a, b, c, d], NOW)?.head.id).toBe("c");
    expect(pressureVictim([d], NOW)).toBeNull();
    expect(pressureVictim([], NOW)).toBeNull();
  });

  it("is under pressure below the line and stays so until 5 points above it", () => {
    expect(underPressure(false, 9, 10)).toBe(true);
    expect(underPressure(false, 12, 10)).toBe(false);
    expect(underPressure(true, 12, 10)).toBe(true);
    expect(underPressure(true, 15, 10)).toBe(false);
  });
});
