import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import type { Session } from "../../shared/types";
import { stageEventFromHook } from "./stage-hook";

const sess = (o: Partial<Session> = {}): Session => ({
  id: "s1", ticketKey: null, cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: null,
  waitingForInput: false, replacedBy: null, dismissed: false, createdAt: 0, repoId: null, coordinator: false, spawnedBy: null,
  featureId: null, fixesSession: null, epicId: null, model: null, butler: false, ...o,
});
const repo = (...ss: Session[]) => ({ get: (id: string) => ss.find((s) => s.id === id) ?? null });
const skill = (name: string, o: Partial<HookEnvelope> = {}): HookEnvelope => ({
  v: 1, receivedAt: 500, ticket: null, butlerSession: "t1",
  payload: { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Skill", tool_input: { skill: name } }, ...o,
});
const prompt = (text: string): HookEnvelope => ({
  v: 1, receivedAt: 500, ticket: null, butlerSession: "t1",
  payload: { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: text },
});

describe("stageEventFromHook", () => {
  it("records a design skill of a ticket session with its ticket and repo", () => {
    const o = stageEventFromHook(skill("superpowers:brainstorming"), repo(sess({ ticketKey: "BTL-1", repoId: 7 })));
    expect(o).toEqual({
      event: { ticketKey: "BTL-1", repoId: 7, branch: null, featureId: null, epicId: null, sessionId: "s1", kind: "skill", at: 500, data: { name: "superpowers:brainstorming", category: "design" } },
      dedupeKey: "skill:s1:500:superpowers:brainstorming",
    });
  });
  it("a multi-repo coordinator (repoId null) keeps repoId null", () => {
    const o = stageEventFromHook(skill("code-review"), repo(sess({ ticketKey: "BTL-1", coordinator: true })));
    expect(o?.event).toMatchObject({ ticketKey: "BTL-1", repoId: null, data: { category: "review" } });
  });
  it("a fix session counts toward the session it fixes", () => {
    const o = stageEventFromHook(skill("code-review"), repo(sess({ featureId: 3, fixesSession: "t2" }), sess({ id: "t2", ticketKey: "BTL-2", repoId: 9 })));
    expect(o?.event).toMatchObject({ ticketKey: "BTL-2", repoId: 9, featureId: null });
  });
  it("a fix session whose target has no ticket uses the target's feature or epic", () => {
    const f = stageEventFromHook(skill("brainstorming"), repo(sess({ featureId: 3, fixesSession: "t2" }), sess({ id: "t2", featureId: 4 })));
    expect(f?.event).toMatchObject({ ticketKey: null, repoId: null, featureId: 4, epicId: null });
    const e = stageEventFromHook(skill("brainstorming"), repo(sess({ featureId: 3, fixesSession: "t2" }), sess({ id: "t2", epicId: 5 })));
    expect(e?.event).toMatchObject({ ticketKey: null, featureId: null, epicId: 5 });
  });
  it("a feature coordinator gives featureId, an epic session epicId", () => {
    expect(stageEventFromHook(skill("brainstorming"), repo(sess({ featureId: 3 })))?.event).toMatchObject({ ticketKey: null, repoId: null, featureId: 3, epicId: null });
    expect(stageEventFromHook(skill("brainstorming"), repo(sess({ epicId: 5 })))?.event).toMatchObject({ ticketKey: null, featureId: null, epicId: 5 });
  });
  it("a fix session whose target is missing or unattributed gives null", () => {
    expect(stageEventFromHook(skill("code-review"), repo(sess({ fixesSession: "gone" })))).toBeNull();
    expect(stageEventFromHook(skill("code-review"), repo(sess({ fixesSession: "t2" }), sess({ id: "t2" })))).toBeNull();
  });
  it("UserPromptSubmit with a /skill prompt", () => {
    expect(stageEventFromHook(prompt("/code-review high"), repo(sess({ ticketKey: "BTL-1" })))?.event.data).toEqual({ name: "code-review", category: "review" });
    expect(stageEventFromHook(prompt("/handoff"), repo(sess({ ticketKey: "BTL-1" })))).toBeNull();
    expect(stageEventFromHook(prompt("please review"), repo(sess({ ticketKey: "BTL-1" })))).toBeNull();
  });
  it("ignores other tools, uncategorised skills, headless envelopes, unknown, discovered and Butler control sessions", () => {
    const s = repo(sess({ ticketKey: "BTL-1" }));
    const bash = skill("code-review");
    (bash.payload as Record<string, unknown>).tool_name = "Bash";
    expect(stageEventFromHook(bash, s)).toBeNull();
    expect(stageEventFromHook(skill("handoff"), s)).toBeNull();
    expect(stageEventFromHook(skill("code-review", { butlerSession: "headless:x" }), s)).toBeNull();
    expect(stageEventFromHook(skill("code-review"), repo())).toBeNull();
    expect(stageEventFromHook(skill("code-review"), repo(sess({ ticketKey: "BTL-1", origin: "discovered" })))).toBeNull();
    expect(stageEventFromHook(skill("code-review"), repo(sess({ butler: true })))).toBeNull();
  });
});
