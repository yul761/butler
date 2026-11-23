import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import type { Session } from "../../shared/types";
import { REMEMBER_TOOL } from "../claude/project-mcp";
import { broadcastConvention, conventionFromEnvelope } from "./broadcast";
import type { SendInput } from "./mailbox";

const env = (shipherdSession: string | null, input: object, o: { tool?: string; event?: string } = {}): HookEnvelope => ({
  v: 1, receivedAt: 1, ticket: null, shipherdSession,
  payload: { hook_event_name: o.event ?? "PostToolUse", session_id: "claude-id", tool_name: o.tool ?? REMEMBER_TOOL, tool_input: input },
});

const s = (id: string, x: Partial<Session>): Session => ({ id, ticketKey: null, featureId: null, fixesSession: null, coordinator: false, ...x }) as Session;

function setup() {
  // 终端 id → head
  const heads = new Map<string, Session>([
    ["coord", s("coord", { featureId: 7, coordinator: true })],
    ["a", s("a2", { ticketKey: "A-1" })],
    ["a2", s("a2", { ticketKey: "A-1" })],
    ["b", s("b", { ticketKey: "B-1" })],
    ["fix", s("fix", { featureId: 7, fixesSession: "b" })],
    ["other", s("other", { ticketKey: "O-1" })],
    ["solo", s("solo", { ticketKey: "S-1" })],
  ]);
  const features: Record<string, number | null> = { "A-1": 7, "B-1": 7, "O-1": 8, "S-1": null };
  const sent: SendInput[] = [];
  const open = ["coord", "a", "b", "fix", "other", "solo"];
  const d = {
    head: (id: string) => heads.get(id) ?? null,
    ticketFeature: (k: string) => features[k] ?? null,
    openTerms: () => open,
    nameOf: (id: string) => (id === "coord" ? "feature 总控" : heads.get(id)?.ticketKey ?? id),
    send: (x: SendInput) => void sent.push(x),
  };
  return { d, sent, open };
}

describe("convention broadcast (BTL-245)", () => {
  it("pushes a remembered convention to the other open sessions of the same feature, not to the author", () => {
    const { d, sent } = setup();
    expect(broadcastConvention(d, env("a", { text: "  接口用 v2  " }))).toBe(3);
    expect(sent.map((m) => m.to).sort()).toEqual(["b", "coord", "fix"]);
    for (const m of sent) {
      expect(m).toMatchObject({ kind: "convention", from: "a2", featureId: 7 });
      expect(m.body).toContain("A-1");
      expect(m.body).toContain("接口用 v2");
    }
  });

  it("works from the coordinator and from a fix session; a session in no feature pushes nothing", () => {
    const { d, sent } = setup();
    expect(broadcastConvention(d, env("coord", { text: "x" }))).toBe(3);
    expect(sent.map((m) => m.to).sort()).toEqual(["a2", "b", "fix"]);
    sent.length = 0;
    expect(broadcastConvention(d, env("fix", { text: "y" }))).toBe(3);
    expect(sent.map((m) => m.to).sort()).toEqual(["a2", "b", "coord"]);
    expect(broadcastConvention(d, env("solo", { text: "z" }))).toBe(0);
    expect(broadcastConvention(d, env("ghost", { text: "z" }))).toBe(0);
  });

  it("sends once per session even when two terminals map to the same head", () => {
    const { d, sent, open } = setup();
    open.push("a2");
    broadcastConvention(d, env("b", { text: "x" }));
    expect(sent.filter((m) => m.to === "a2")).toHaveLength(1);
  });

  it("ignores consolidate, empty text, other tools, other events and headless sessions", () => {
    expect(conventionFromEnvelope(env("a", { text: "long", consolidate: true }))).toBeNull();
    expect(conventionFromEnvelope(env("a", { text: "  " }))).toBeNull();
    expect(conventionFromEnvelope(env("a", { text: "x" }, { tool: "mcp__shipherd-memory__remember" }))).toBeNull();
    expect(conventionFromEnvelope(env("a", { text: "x" }, { event: "PreToolUse" }))).toBeNull();
    expect(conventionFromEnvelope(env("headless:1", { text: "x" }))).toBeNull();
    // 外部终端（没有 SHIPHERD_SESSION）：按 claude 的 session id 找作者。
    expect(conventionFromEnvelope(env(null, { text: "x" }))).toEqual({ author: "claude-id", text: "x" });
  });
});
