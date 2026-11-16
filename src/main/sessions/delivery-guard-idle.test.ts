import { describe, expect, it } from "vitest";
import { EpicsRepo } from "../db/epics-repo";
import { FeaturesRepo } from "../db/features-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import { applyHookEnvelope } from "../hooks/hook-events";
import { applyEntry, newTranscriptState, type TranscriptState } from "./activity-parse";
import { deriveActivity } from "./activity-monitor";
import { DeliveryGuard } from "./delivery-guard";
import { markTurnEndedWithoutStop } from "./turn-end";
import type { SessionActivity } from "../../shared/activity";
import type { HookEnvelope } from "../../shared/hook-envelope";

/**
 * 开着的终端里 Claude Code 不发 Stop hook 的几种停下来的方式（BTL-190 follow-up D）：send_message 过 DeliveryGuard 时都应该放行。
 * 一个开着的终端 term（BUTLER_SESSION=term），epic session 或 feature 总控。activity 用真的 transcript 解析得出（和 ActivityMonitor.update 一样）。 */
function world(kind: "epic" | "feature") {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const featureId = new FeaturesRepo(db).insert({ name: "f", workspaceDir: "/fs", createdAt: 1 });
  const epicId = new EpicsRepo(db).insert({ name: "e", workspaceDir: "/es", createdAt: 1 });
  const cwd = kind === "epic" ? "/es" : "/fs";
  // 和 startInWorkspace 一样先插行
  sessions.insertIfAbsent({ id: "term", ticketKey: null, cwd, origin: "butler", createdAt: 1, ...(kind === "epic" ? { epicId } : { featureId, coordinator: true }) });
  const deps = { sessions, tickets, featureForCwd: (c: string) => (c === "/fs" ? featureId : null), epicForCwd: (c: string) => (c === "/es" ? epicId : null) };
  let at = 100;
  const hook = (event: string, id = "term", payload: Record<string, unknown> = {}) => {
    const env: HookEnvelope = { v: 1, receivedAt: at++, ticket: null, butlerSession: "term", payload: { hook_event_name: event, session_id: id, cwd, ...payload } };
    return applyHookEnvelope(env, deps);
  };
  let transcript: TranscriptState | null = null; // null = 还没有 transcript 文件（readTranscript 返回 newTranscriptState）
  const write = (...entries: unknown[]) => {
    transcript ??= newTranscriptState();
    for (const e of entries) applyEntry(transcript, e);
    // 和 ActivityMonitor 一样取走事件；index.ts 的 onTurnEnd 做的就是 markTurnEndedWithoutStop（轮次关着、没有后续输入时）。
    const events = transcript.events.splice(0);
    const end = events.filter((e) => e.type === "turn-end" || e.type === "turn-start").at(-1);
    if (end?.type === "turn-end" && end.hookless && !transcript.turnOpen) markTurnEndedWithoutStop(sessions, "term", end.at);
  };
  const activity = (): SessionActivity => {
    const d = deriveActivity(transcript ?? newTranscriptState(), false);
    return { sessionId: "term", kind: d.kind, detail: d.detail, background: d.background, startedAt: d.startedAt, lastOutputAt: null, stuck: null, reason: null, action: null, lastOutput: [] };
  };
  const guard = new DeliveryGuard({
    termOf: (id) => (sessions.head(id) ? "term" : null),
    head: (id) => sessions.head(id),
    activity: () => activity(),
    pty: { lastUserInputAt: () => 0, screenNeedsUser: () => false, hasDraft: () => false, autoInputInFlight: () => false },
    now: () => 10_000_000,
  });
  const state = () => ({ waitingForInput: sessions.head("term")!.waitingForInput, activity: activity().kind, check: guard.check("term") });
  return { hook, write, state, sessions };
}
const ts = (s: number) => new Date(s * 1000).toISOString();
const userMsg = (t: number, text: string) => ({ type: "user", timestamp: ts(t), message: { role: "user", content: text } });
const asst = (t: number, stop: string, content: unknown[]) => ({ type: "assistant", timestamp: ts(t), message: { id: "m" + t, role: "assistant", stop_reason: stop, content } });

for (const kind of ["epic", "feature"] as const) {
  describe(kind, () => {
    it("control: normal turn with Stop -> ok", () => {
      const w = world(kind);
      w.hook("SessionStart", "term", { source: "startup" });
      w.hook("UserPromptSubmit", "term", { prompt: "hi" });
      w.write(userMsg(1, "hi"), asst(2, "end_turn", [{ type: "text", text: "done" }]), { type: "system", subtype: "turn_duration", timestamp: ts(2) });
      w.hook("Stop");
      expect(w.state().check.ok).toBe(true);
    });
    it("A: fresh session opened, never prompted (SessionStart startup only) -> ok, and a prompt makes it busy again", () => {
      const w = world(kind);
      w.hook("SessionStart", "term", { source: "startup" });
      expect(w.state()).toMatchObject({ waitingForInput: true, activity: "waiting", check: { ok: true } });
      w.hook("UserPromptSubmit", "term", { prompt: "hi" });
      expect(w.state().check).toMatchObject({ ok: false, block: "busy" });
    });
    it("B: user pressed Esc mid-turn (no Stop hook)", () => {
      const w = world(kind);
      w.hook("SessionStart", "term", { source: "startup" });
      w.hook("UserPromptSubmit", "term", { prompt: "go" });
      w.write(userMsg(1, "go"), asst(2, "tool_use", [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 100" } }]),
        { type: "user", timestamp: ts(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "interrupted" }] } },
        userMsg(3, "[Request interrupted by user for tool use]"));
      expect(w.state()).toMatchObject({ waitingForInput: true, activity: "waiting", check: { ok: true } });
    });
    it("C: turn ended by rate limit / API error (StopFailure, not Stop)", () => {
      const w = world(kind);
      w.hook("SessionStart", "term", { source: "startup" });
      w.hook("UserPromptSubmit", "term", { prompt: "go" });
      w.write(userMsg(1, "go"), { type: "assistant", isApiErrorMessage: true, timestamp: ts(2), message: { id: "x", model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text: "You've hit your 5-hour limit" }] } },
        { type: "system", subtype: "turn_duration", timestamp: ts(2) });
      // StopFailure hook 没装（装了会让已有的安装报 partial），靠 transcript
      expect(w.hook("StopFailure")).toMatchObject({ kind: "ignored" });
      expect(w.state()).toMatchObject({ waitingForInput: true, activity: "waiting", check: { ok: true } });
    });
    it("a turn still running (tool_use, no end) stays busy", () => {
      const w = world(kind);
      w.hook("SessionStart", "term", { source: "startup" });
      w.hook("UserPromptSubmit", "term", { prompt: "go" });
      w.write(userMsg(1, "go"), asst(2, "tool_use", [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 100" } }]));
      expect(w.state().check).toMatchObject({ ok: false });
    });
    it("D: resumed (claude --resume) with no Stop -> ok (already handled)", () => {
      const w = world(kind);
      w.write(userMsg(1, "old"), asst(2, "end_turn", [{ type: "text", text: "old reply" }]), { type: "system", subtype: "turn_duration", timestamp: ts(2) });
      w.hook("SessionStart", "term", { source: "resume" });
      expect(w.state().check.ok).toBe(true);
    });
  });
}
