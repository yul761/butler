import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { insertTicket, memDb, tempDir } from "../test-utils";
import { captureCommandHandoff, stopFromEnvelope } from "./capture";
import { ingestHandoff, type IngestInput } from "./ingest";
import { emptyHandoff } from "./schema";

const FENCE = "```";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  for (const key of ["PROJ-1", "PROJ-2"]) {
    insertTicket(tickets, { key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  }
  const sessions = new SessionsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  let n = 0;
  const ingest = (input: IngestInput) => ingestHandoff({ db, tickets, handoffs, followups, now: () => 100, newFollowupId: () => `f${++n}` }, input);
  return { deps: { sessions, tickets, ingest }, sessions, handoffs };
}

/** 一个只有“/handoff + 回答”的 transcript；payload 是字符串时原样放进代码块。 */
function transcript(payload: unknown, uuid = "a1"): string {
  const file = join(tempDir(), "t.jsonl");
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const entries = [
    { type: "user", message: { role: "user", content: "/handoff" } },
    { type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text: `${FENCE}butler-handoff\n${body}\n${FENCE}` }] } },
  ];
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

describe("stopFromEnvelope", () => {
  const env = (payload: unknown, butlerSession: string | null = null): HookEnvelope => ({ v: 1, receivedAt: 1, ticket: null, butlerSession, payload });

  it("extracts session and transcript from Stop only, never from headless runs", () => {
    const stop = { hook_event_name: "Stop", session_id: "s1", transcript_path: "/t.jsonl" };
    expect(stopFromEnvelope(env(stop))).toEqual({ sessionId: "s1", transcriptPath: "/t.jsonl" });
    expect(stopFromEnvelope(env(stop, "headless:r1"))).toBeNull();
    expect(stopFromEnvelope(env({ ...stop, hook_event_name: "SessionEnd" }))).toBeNull();
    expect(stopFromEnvelope(env({ hook_event_name: "Stop", session_id: "s1" }))).toBeNull();
    expect(stopFromEnvelope(env(null))).toBeNull();
  });
});

describe("captureCommandHandoff", () => {
  it("stores a /handoff block under the session's ticket with trigger command", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = transcript({ ...emptyHandoff("WHATEVER-1"), done_today: ["写完了"] });
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toMatchObject({ stored: true, degraded: false });
    expect(handoffs.latest("PROJ-1")).toMatchObject({ trigger: "command", sessionId: "s1", sourceRef: "a1", payload: { ticket: "PROJ-1", done_today: ["写完了"] } });
  });

  it("does not store the same output twice when Stop is handled again", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = transcript(emptyHandoff("PROJ-1"));
    await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file });
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toEqual({ stored: false, reason: "duplicate" });
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(1);
  });

  it("falls back to the ticket named in the block for an unclaimed session, else gives up", async () => {
    const { deps, handoffs } = setup();
    expect(await captureCommandHandoff(deps, { sessionId: "loose", transcriptPath: transcript(emptyHandoff("proj-2")) })).toMatchObject({ stored: true });
    expect(handoffs.latest("PROJ-2")?.trigger).toBe("command");
    expect(await captureCommandHandoff(deps, { sessionId: "loose", transcriptPath: transcript(emptyHandoff("NOPE-9"), "a2") })).toEqual({
      stored: false, reason: "no_ticket",
    });
  });

  it("keeps an invalid block as a degraded handoff with its raw text", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const raw = '{"ticket":"PROJ-1","status":"shipping"}';
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: transcript(raw) })).toMatchObject({ stored: true, degraded: true });
    expect(handoffs.latest("PROJ-1")).toMatchObject({ degraded: true, rawText: raw });
  });

  it("returns null when there is no block or no file", async () => {
    const { deps } = setup();
    const file = join(tempDir(), "plain.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "assistant", uuid: "x", message: { content: [{ type: "text", text: "普通回答" }] } })}\n`);
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toBeNull();
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: join(tempDir(), "missing.jsonl") })).toBeNull();
  });

  it("ignores a turn where the assistant merely quotes a fence without /handoff", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = join(tempDir(), "quote.jsonl");
    const entries = [
      { type: "user", message: { role: "user", content: "给我看看 handoff 的格式" } },
      { type: "assistant", uuid: "q1", message: { role: "assistant", content: [{ type: "text", text: `${FENCE}butler-handoff\n${JSON.stringify(emptyHandoff("PROJ-1"))}\n${FENCE}` }] } },
    ];
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toBeNull();
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(0);
  });

  it("ingests the V4-shaped /handoff turn (command message + isMeta expansion)", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = join(tempDir(), "v4.jsonl");
    const entries = [
      { type: "user", message: { role: "user", content: "<command-message>handoff</command-message>\n<command-name>/handoff</command-name>" } },
      { type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: `示例：\n${FENCE}butler-handoff\n{}\n${FENCE}` }] } },
      { type: "assistant", uuid: "v1", message: { role: "assistant", content: [{ type: "text", text: `${FENCE}butler-handoff\n${JSON.stringify(emptyHandoff("PROJ-1"))}\n${FENCE}` }] } },
    ];
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toMatchObject({ stored: true });
    expect(handoffs.latest("PROJ-1")).toMatchObject({ trigger: "command", sourceRef: "v1" });
  });
});
